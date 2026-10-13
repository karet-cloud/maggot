// An SSH server (RFC 4253, 4252, 4254) small enough for a Worker, with the transport carried over a
// WebSocket. It does what git needs and no more: post-quantum hybrid (ML-KEM-768 with X25519) or plain
// curve25519 key exchange, an Ed25519 host key, AES-GCM, public key authentication, and session
// channels that run one command each.
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { algorithmFits, signWithHostKey, SIGNATURE_ALGORITHMS, verifySignature, type HostKey } from "./keys.ts";
import { base64, concat, Reader, sha256, SshError, Writer } from "./wire.ts";

const MSG = {
	DISCONNECT: 1,
	IGNORE: 2,
	UNIMPLEMENTED: 3,
	DEBUG: 4,
	SERVICE_REQUEST: 5,
	SERVICE_ACCEPT: 6,
	EXT_INFO: 7,
	KEXINIT: 20,
	NEWKEYS: 21,
	KEX_ECDH_INIT: 30,
	KEX_ECDH_REPLY: 31,
	USERAUTH_REQUEST: 50,
	USERAUTH_FAILURE: 51,
	USERAUTH_SUCCESS: 52,
	USERAUTH_PK_OK: 60,
	GLOBAL_REQUEST: 80,
	REQUEST_FAILURE: 82,
	CHANNEL_OPEN: 90,
	CHANNEL_OPEN_CONFIRMATION: 91,
	CHANNEL_OPEN_FAILURE: 92,
	CHANNEL_WINDOW_ADJUST: 93,
	CHANNEL_DATA: 94,
	CHANNEL_EXTENDED_DATA: 95,
	CHANNEL_EOF: 96,
	CHANNEL_CLOSE: 97,
	CHANNEL_REQUEST: 98,
	CHANNEL_SUCCESS: 99,
	CHANNEL_FAILURE: 100,
} as const;

const DISCONNECT_REASON = { PROTOCOL_ERROR: 2, KEY_EXCHANGE_FAILED: 3, NO_MORE_AUTH_METHODS: 14, BY_APPLICATION: 11 } as const;

const SERVER_VERSION = "SSH-2.0-megit_1.0";
// OpenSSH 10 prefers the hybrid and warns about anything that isn't post-quantum.
const HYBRID_KEX = "mlkem768x25519-sha256";
const KEX_ALGORITHMS = [HYBRID_KEX, "curve25519-sha256", "curve25519-sha256@libssh.org"];
const MLKEM_PUBLIC_KEY_BYTES = 1184;
const HOST_KEY_ALGORITHMS = ["ssh-ed25519"];
const CIPHERS: Record<string, number> = { "aes128-gcm@openssh.com": 16, "aes256-gcm@openssh.com": 32 };
// AES-GCM authenticates packets itself, so the MAC that's negotiated is never used.
const MACS = ["hmac-sha2-256"];

/** Longest packet accepted: room for a full channel data message and then some. */
const MAX_PACKET = 256 * 1024;
/** What the client may send on a channel before we've read it. */
const CHANNEL_WINDOW = 2 * 1024 * 1024;
const CHANNEL_MAX_PACKET = 32 * 1024;
const MAX_CHANNELS = 4;
const MAX_AUTH_ATTEMPTS = 20;
/** Unparsed input a client may have waiting: every channel's window and then some. */
const MAX_UNPARSED = (MAX_CHANNELS + 2) * CHANNEL_WINDOW;
/** Time allowed from connecting to authenticating. */
const AUTH_TIMEOUT_MS = 30_000;

export interface SshUser {
	username: string;
}

export interface SshHandlers<U extends SshUser> {
	/** The account a public key blob belongs to, or null. */
	lookupKey(blob: Uint8Array): Promise<U | null>;
	/** Runs a command; resolves to its exit status. */
	exec(session: Session<U>, command: string): Promise<number>;
}

export interface SshOptions<U extends SshUser> extends SshHandlers<U> {
	hostKey: HostKey;
	/** Sends bytes to the client. */
	send(bytes: Uint8Array): void;
	/** Closes the connection. */
	close(reason: string): void;
}

type Cipher = { key: CryptoKey; iv: Uint8Array };

/** One SSH connection. Feed it the client's bytes with `receive`; it answers through `send`. */
export class SshServer<U extends SshUser> {
	private readonly opts: SshOptions<U>;
	/** Bytes received but not yet parsed: a partial packet, then whatever arrived since. */
	private input: Uint8Array = new Uint8Array(0);
	private arrived: Uint8Array[] = [];
	private arrivedBytes = 0;
	private versionSeen = false;
	private clientVersion = "";
	/** Incoming bytes are handled one packet at a time, in order. */
	private processing: Promise<void> = Promise.resolve();
	/** Outgoing packets are encrypted in order. */
	private sending: Promise<void> = Promise.resolve();
	private recvSeq = 0;
	private sendSeq = 0;
	private recvCipher: Cipher | null = null;
	private sendCipher: Cipher | null = null;
	private sessionId: Uint8Array | null = null;

	// Key exchange in progress.
	private serverKexInit: Uint8Array | null = null;
	private clientKexInit: Uint8Array | null = null;
	private chosenCipher = "";
	private chosenKex = "";
	private pendingKeys: { recv: Cipher; send: Cipher } | null = null;
	private ignoreNextPacket = false;
	/** Non-key-exchange messages wait here while keys are being changed. */
	private held: Uint8Array[] | null = null;
	private clientWantsExtInfo = false;

	private user: U | null = null;
	private readonly keyCache = new Map<string, Promise<U | null>>();
	private authFailures = 0;
	private readonly authTimer: ReturnType<typeof setTimeout>;
	private readonly channels = new Map<number, Session<U>>();
	private nextChannelId = 0;
	private closed = false;

	constructor(opts: SshOptions<U>) {
		this.opts = opts;
		this.opts.send(new TextEncoder().encode(`${SERVER_VERSION}\r\n`));
		this.startKex();
		this.authTimer = setTimeout(() => this.disconnect(DISCONNECT_REASON.BY_APPLICATION, "Authentication timed out"), AUTH_TIMEOUT_MS);
	}

	/** Bytes from the client. */
	receive(bytes: Uint8Array): void {
		if (this.closed) return;
		// Joined once per pass of drain(), not per message, so a burst isn't copied over and over.
		this.arrived.push(bytes.slice());
		this.arrivedBytes += bytes.length;
		if (this.arrivedBytes > MAX_UNPARSED) {
			this.fail(new SshError("Sending faster than the window allows"));
			return;
		}
		this.processing = this.processing.then(() => this.drain()).catch((err) => this.fail(err));
	}

	/** The client went away. */
	closedByPeer(): void {
		this.shutdown();
	}

	private shutdown() {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.authTimer);
		for (const channel of this.channels.values()) channel.abort();
		this.channels.clear();
	}

	private fail(err: unknown) {
		if (this.closed) return;
		if (!(err instanceof SshError)) console.error("ssh connection failed", err);
		this.disconnect(DISCONNECT_REASON.PROTOCOL_ERROR, err instanceof SshError ? err.message : "Internal error");
	}

	private disconnect(reason: number, message: string) {
		if (this.closed) return;
		// Straight out, past any held messages, then the socket closes.
		const payload = new Writer().byte(MSG.DISCONNECT).uint32(reason).string(message).string("").finish();
		this.sending = this.sending.then(() => this.writePacket(payload)).catch(() => {});
		void this.sending.then(() => this.opts.close(message));
		this.shutdown();
	}

	// ── Reading packets ──────────────────────────────────────────────────────

	private async drain(): Promise<void> {
		if (this.arrived.length > 0) {
			this.input = concat([this.input, ...this.arrived]);
			this.arrived = [];
			this.arrivedBytes = 0;
		}
		if (!this.versionSeen) {
			const end = this.input.indexOf(0x0a);
			if (end < 0) {
				if (this.input.length > 255) throw new SshError("No SSH version line");
				return;
			}
			const line = new TextDecoder().decode(this.input.subarray(0, end)).replace(/\r$/, "");
			this.input = this.input.subarray(end + 1);
			if (!line.startsWith("SSH-2.0-")) throw new SshError("Only SSH 2.0 is supported");
			this.clientVersion = line;
			this.versionSeen = true;
		}
		for (;;) {
			const payload = await this.nextPacket();
			if (!payload) return;
			const seq = this.recvSeq;
			this.recvSeq = (this.recvSeq + 1) >>> 0;
			if (this.ignoreNextPacket) {
				this.ignoreNextPacket = false;
				continue;
			}
			await this.dispatch(payload, seq);
			if (this.closed) return;
		}
	}

	/** The next whole packet's payload, or null until more bytes arrive. */
	private async nextPacket(): Promise<Uint8Array | null> {
		if (this.input.length < 4) return null;
		const length = new DataView(this.input.buffer, this.input.byteOffset, 4).getUint32(0);
		if (length > MAX_PACKET || length < 5) throw new SshError("Bad packet length");
		const cipher = this.recvCipher;
		const total = 4 + length + (cipher ? 16 : 0);
		if (this.input.length < total) return null;
		const packet = this.input.subarray(0, total);
		this.input = this.input.subarray(total);
		let body: Uint8Array;
		if (cipher) {
			if (length % 16 !== 0) throw new SshError("Bad packet length");
			try {
				body = new Uint8Array(
					await crypto.subtle.decrypt({ name: "AES-GCM", iv: cipher.iv, additionalData: packet.subarray(0, 4), tagLength: 128 }, cipher.key, packet.subarray(4)),
				);
			} catch {
				throw new SshError("Packet failed authentication");
			}
			incrementIv(cipher.iv);
		} else {
			if (total % 8 !== 0) throw new SshError("Bad packet length");
			body = packet.subarray(4);
		}
		const padding = body[0];
		if (padding < 4 || padding + 1 > body.length) throw new SshError("Bad padding");
		return body.slice(1, body.length - padding);
	}

	// ── Writing packets ──────────────────────────────────────────────────────

	/** Queues a message. While keys change, only key exchange messages go out. */
	send(payload: Uint8Array): void {
		if (this.closed) return;
		const type = payload[0];
		const kexMessage = type <= MSG.EXT_INFO || (type >= MSG.KEXINIT && type < MSG.USERAUTH_REQUEST);
		if (this.held && !kexMessage) {
			this.held.push(payload);
			return;
		}
		this.sending = this.sending.then(() => this.writePacket(payload)).catch((err) => this.fail(err));
	}

	private async writePacket(payload: Uint8Array): Promise<void> {
		const cipher = this.sendCipher;
		const block = cipher ? 16 : 8;
		// With AES-GCM the length isn't encrypted, so it doesn't count towards the block size.
		const counted = (cipher ? 0 : 4) + 1 + payload.length;
		let padding = block - (counted % block);
		if (padding < 4) padding += block;
		const length = 1 + payload.length + padding;
		const header = new Writer().uint32(length).finish();
		const body = new Uint8Array(length);
		body[0] = padding;
		body.set(payload, 1);
		crypto.getRandomValues(body.subarray(1 + payload.length));
		let packet: Uint8Array;
		if (cipher) {
			const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: cipher.iv, additionalData: header, tagLength: 128 }, cipher.key, body));
			incrementIv(cipher.iv);
			packet = concat([header, sealed]);
		} else {
			packet = concat([header, body]);
		}
		this.sendSeq = (this.sendSeq + 1) >>> 0;
		if (!this.closed || payload[0] === MSG.DISCONNECT) this.opts.send(packet);
	}

	// ── Messages ─────────────────────────────────────────────────────────────

	private async dispatch(payload: Uint8Array, seq: number): Promise<void> {
		const r = new Reader(payload);
		const type = r.byte();
		switch (type) {
			case MSG.DISCONNECT:
				this.opts.close("Client disconnected");
				this.shutdown();
				return;
			case MSG.IGNORE:
			case MSG.DEBUG:
			case MSG.UNIMPLEMENTED:
				return;
			case MSG.KEXINIT:
				return this.onKexInit(payload, r);
			case MSG.KEX_ECDH_INIT:
				return this.onKexEcdhInit(r);
			case MSG.NEWKEYS:
				return this.onNewKeys();
		}
		// Nothing but key exchange before the first keys are in place.
		if (!this.sessionId || !this.recvCipher) throw new SshError("Unexpected message before key exchange");
		switch (type) {
			case MSG.SERVICE_REQUEST: {
				const service = r.text();
				if (service !== "ssh-userauth") throw new SshError(`Unknown service ${service}`);
				this.send(new Writer().byte(MSG.SERVICE_ACCEPT).string(service).finish());
				return;
			}
			case MSG.USERAUTH_REQUEST:
				return this.onUserAuth(r);
		}
		if (!this.user) throw new SshError("Not authenticated");
		switch (type) {
			case MSG.GLOBAL_REQUEST: {
				r.text();
				if (r.bool()) this.send(Uint8Array.of(MSG.REQUEST_FAILURE));
				return;
			}
			case MSG.CHANNEL_OPEN:
				return this.onChannelOpen(r);
			case MSG.CHANNEL_REQUEST:
				return this.onChannelRequest(r);
			case MSG.CHANNEL_DATA: {
				const channel = this.channel(r.uint32());
				channel?.received(r.string());
				return;
			}
			case MSG.CHANNEL_EXTENDED_DATA:
				return;
			case MSG.CHANNEL_WINDOW_ADJUST: {
				const channel = this.channel(r.uint32());
				channel?.windowAdjusted(r.uint32());
				return;
			}
			case MSG.CHANNEL_EOF:
				this.channel(r.uint32())?.endOfInput();
				return;
			case MSG.CHANNEL_CLOSE: {
				const id = r.uint32();
				const channel = this.channel(id);
				if (channel) {
					channel.closedByPeer();
					this.channels.delete(id);
				}
				return;
			}
			default:
				this.send(new Writer().byte(MSG.UNIMPLEMENTED).uint32(seq).finish());
		}
	}

	// ── Key exchange ─────────────────────────────────────────────────────────

	private startKex() {
		const cookie = crypto.getRandomValues(new Uint8Array(16));
		this.serverKexInit = new Writer()
			.byte(MSG.KEXINIT)
			.raw(cookie)
			.nameList(KEX_ALGORITHMS)
			.nameList(HOST_KEY_ALGORITHMS)
			.nameList(Object.keys(CIPHERS))
			.nameList(Object.keys(CIPHERS))
			.nameList(MACS)
			.nameList(MACS)
			.nameList(["none"])
			.nameList(["none"])
			.nameList([])
			.nameList([])
			.bool(false)
			.uint32(0)
			.finish();
		this.held ??= [];
		this.send(this.serverKexInit);
	}

	private onKexInit(payload: Uint8Array, r: Reader) {
		if (this.clientKexInit) throw new SshError("Key exchange already in progress");
		// The client started a re-key: answer with ours.
		if (!this.serverKexInit) this.startKex();
		this.clientKexInit = payload.slice();
		r.raw(16);
		const kex = r.nameList();
		const hostKeys = r.nameList();
		const ciphersIn = r.nameList();
		const ciphersOut = r.nameList();
		r.nameList();
		r.nameList();
		const compressionIn = r.nameList();
		const compressionOut = r.nameList();
		r.nameList();
		r.nameList();
		const guessFollows = r.bool();
		if (!this.sessionId) this.clientWantsExtInfo = kex.includes("ext-info-c");
		const chosenKex = kex.find((k) => KEX_ALGORITHMS.includes(k));
		const hostKey = hostKeys.find((k) => HOST_KEY_ALGORITHMS.includes(k));
		const cipherIn = ciphersIn.find((c) => c in CIPHERS);
		const cipherOut = ciphersOut.find((c) => c in CIPHERS);
		if (!chosenKex || !hostKey || !cipherIn || !cipherOut || !compressionIn.includes("none") || !compressionOut.includes("none")) {
			throw new SshError("No common algorithms: megit's SSH needs curve25519-sha256, ssh-ed25519 and AES-GCM (any OpenSSH from the last ten years)");
		}
		if (cipherIn !== cipherOut) throw new SshError("Use the same cipher in both directions");
		this.chosenCipher = cipherIn;
		this.chosenKex = chosenKex;
		// A guessed first key exchange packet that guessed wrong is skipped.
		if (guessFollows && kex[0] !== chosenKex) this.ignoreNextPacket = true;
	}

	private async onKexEcdhInit(r: Reader) {
		if (!this.clientKexInit || !this.serverKexInit) throw new SshError("Unexpected key exchange message");
		const clientPublic = r.string();
		const hybrid = this.chosenKex === HYBRID_KEX;
		// The hybrid's client value is an ML-KEM-768 encapsulation key followed by an X25519 public key.
		if (clientPublic.length !== (hybrid ? MLKEM_PUBLIC_KEY_BYTES + 32 : 32)) throw new SshError("Bad key exchange value");
		const x25519 = await x25519Agree(clientPublic.subarray(clientPublic.length - 32));
		let serverPublic: Uint8Array;
		/** The shared secret K, encoded as it goes into the exchange hash and key derivation. */
		let secret: Uint8Array;
		if (hybrid) {
			let kem: { cipherText: Uint8Array; sharedSecret: Uint8Array };
			try {
				kem = ml_kem768.encapsulate(clientPublic.subarray(0, MLKEM_PUBLIC_KEY_BYTES));
			} catch {
				throw new SshError("Bad ML-KEM public key");
			}
			serverPublic = concat([kem.cipherText, x25519.publicKey]);
			// K = SHA-256(ML-KEM secret || X25519 secret), as a string rather than an mpint.
			secret = new Writer().string(await sha256(kem.sharedSecret, x25519.shared)).finish();
		} else {
			serverPublic = x25519.publicKey;
			secret = new Writer().mpint(x25519.shared).finish();
		}
		const host = this.opts.hostKey;
		const exchangeHash = await sha256(
			new Writer()
				.string(this.clientVersion)
				.string(SERVER_VERSION)
				.string(this.clientKexInit)
				.string(this.serverKexInit)
				.string(host.blob)
				.string(clientPublic)
				.string(serverPublic)
				.raw(secret)
				.finish(),
		);
		this.sessionId ??= exchangeHash;
		const signature = await signWithHostKey(host, exchangeHash);
		this.send(new Writer().byte(MSG.KEX_ECDH_REPLY).string(host.blob).string(serverPublic).string(signature).finish());

		const size = CIPHERS[this.chosenCipher];
		const derive = async (letter: string, length: number) => {
			let out = await sha256(secret, exchangeHash, new TextEncoder().encode(letter), this.sessionId as Uint8Array);
			while (out.length < length) out = concat([out, await sha256(secret, exchangeHash, out)]);
			return out.slice(0, length);
		};
		const cipher = async (ivLetter: string, keyLetter: string): Promise<Cipher> => ({
			iv: await derive(ivLetter, 12),
			key: await crypto.subtle.importKey("raw", await derive(keyLetter, size), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]),
		});
		this.pendingKeys = { recv: await cipher("A", "C"), send: await cipher("B", "D") };
		// NEWKEYS goes out under the old keys; everything after it under the new ones.
		const keys = this.pendingKeys;
		this.sending = this.sending
			.then(() => this.writePacket(Uint8Array.of(MSG.NEWKEYS)))
			.then(() => {
				this.sendCipher = keys.send;
			})
			.catch((err) => this.fail(err));
		this.serverKexInit = null;
		this.clientKexInit = null;
		const held = this.held ?? [];
		this.held = null;
		for (const payload of held) this.send(payload);
	}

	private onNewKeys() {
		if (!this.pendingKeys) throw new SshError("Unexpected NEWKEYS");
		const first = this.recvCipher === null;
		this.recvCipher = this.pendingKeys.recv;
		this.pendingKeys = null;
		// Tells OpenSSH which signature algorithms we accept, so RSA keys sign with SHA-2.
		if (first && this.clientWantsExtInfo) {
			this.send(new Writer().byte(MSG.EXT_INFO).uint32(1).string("server-sig-algs").nameList(SIGNATURE_ALGORITHMS).finish());
		}
	}

	// ── Authentication ───────────────────────────────────────────────────────

	private async onUserAuth(r: Reader) {
		if (this.user) return; // Already in; later requests are ignored, as RFC 4252 allows.
		const username = r.string();
		const service = r.text();
		const method = r.text();
		const failure = () => {
			this.authFailures++;
			if (this.authFailures > MAX_AUTH_ATTEMPTS) {
				this.disconnect(DISCONNECT_REASON.NO_MORE_AUTH_METHODS, "Too many authentication failures");
				return;
			}
			this.send(new Writer().byte(MSG.USERAUTH_FAILURE).nameList(["publickey"]).bool(false).finish());
		};
		if (service !== "ssh-connection" || method !== "publickey") return failure();
		const signed = r.bool();
		const algorithm = r.text();
		const blob = r.string();
		const keyType = new Reader(blob).text();
		if (!algorithmFits(keyType, algorithm)) return failure();
		const account = await this.account(blob);
		if (!account) return failure();
		if (!signed) {
			this.send(new Writer().byte(MSG.USERAUTH_PK_OK).string(algorithm).string(blob).finish());
			return;
		}
		const signature = r.string();
		const data = new Writer()
			.string(this.sessionId as Uint8Array)
			.byte(MSG.USERAUTH_REQUEST)
			.string(username)
			.string(service)
			.string("publickey")
			.bool(true)
			.string(algorithm)
			.string(blob)
			.finish();
		if (!(await verifySignature(blob, algorithm, signature, data))) return failure();
		this.user = account;
		clearTimeout(this.authTimer);
		this.send(Uint8Array.of(MSG.USERAUTH_SUCCESS));
	}

	private account(blob: Uint8Array): Promise<U | null> {
		const key = base64(blob);
		let found = this.keyCache.get(key);
		if (!found) {
			found = this.opts.lookupKey(blob);
			this.keyCache.set(key, found);
		}
		return found;
	}

	// ── Channels ─────────────────────────────────────────────────────────────

	private channel(id: number): Session<U> | undefined {
		return this.channels.get(id);
	}

	private onChannelOpen(r: Reader) {
		const type = r.text();
		const sender = r.uint32();
		const window = r.uint32();
		const maxPacket = r.uint32();
		if (type !== "session" || this.channels.size >= MAX_CHANNELS) {
			this.send(
				new Writer()
					.byte(MSG.CHANNEL_OPEN_FAILURE)
					.uint32(sender)
					.uint32(type === "session" ? 4 : 3) // resource shortage, or unknown channel type
					.string(type === "session" ? "Too many channels" : "Only session channels are supported")
					.string("")
					.finish(),
			);
			return;
		}
		const id = this.nextChannelId++;
		const session = new Session<U>(this, this.user as U, id, sender, window, Math.min(maxPacket, CHANNEL_MAX_PACKET));
		this.channels.set(id, session);
		this.send(new Writer().byte(MSG.CHANNEL_OPEN_CONFIRMATION).uint32(sender).uint32(id).uint32(CHANNEL_WINDOW).uint32(CHANNEL_MAX_PACKET).finish());
	}

	private onChannelRequest(r: Reader) {
		const channel = this.channel(r.uint32());
		const type = r.text();
		const wantReply = r.bool();
		if (!channel) return;
		const reply = (ok: boolean) => {
			if (wantReply) this.send(new Writer().byte(ok ? MSG.CHANNEL_SUCCESS : MSG.CHANNEL_FAILURE).uint32(channel.remoteId).finish());
		};
		if (type === "env") {
			const name = r.text();
			const value = r.text();
			// git sends its protocol version this way.
			if (name === "GIT_PROTOCOL" && value.length < 256) channel.env.set(name, value);
			return reply(true);
		}
		if ((type === "exec" || type === "shell") && !channel.started) {
			const command = type === "exec" ? r.text() : "";
			channel.started = true;
			reply(true);
			void this.run(channel, command);
			return;
		}
		reply(false);
	}

	private async run(channel: Session<U>, command: string) {
		let status = 1;
		try {
			status = await this.opts.exec(channel, command);
		} catch (err) {
			if (!channel.aborted) {
				console.error("ssh command failed", err);
				await channel.stderr("megit: something went wrong on the server; try again.\n").catch(() => {});
			}
		}
		channel.finish(status);
	}

	/** Used by sessions. */
	sendChannelMessage(payload: Uint8Array) {
		this.send(payload);
	}

	forgetChannel(id: number) {
		this.channels.delete(id);
	}
}

/** One session channel: its input, output with the client's flow control, and its environment. */
export class Session<U extends SshUser> {
	readonly env = new Map<string, string>();
	started = false;
	aborted = false;
	readonly signal: AbortSignal;
	private readonly controller = new AbortController();
	private readonly chunks: Uint8Array[] = [];
	private buffered = 0;
	private eof = false;
	private wake: (() => void) | null = null;
	/** Bytes read since the last window adjust. */
	private consumed = 0;
	private window: number;
	private windowWaiters: (() => void)[] = [];
	private closeSent = false;
	private readonly server: SshServer<U>;
	private readonly maxPacket: number;
	readonly user: U;
	readonly localId: number;
	readonly remoteId: number;

	constructor(server: SshServer<U>, user: U, localId: number, remoteId: number, window: number, maxPacket: number) {
		this.server = server;
		this.user = user;
		this.localId = localId;
		this.remoteId = remoteId;
		this.maxPacket = maxPacket;
		this.window = window;
		this.signal = this.controller.signal;
	}

	// Input from the client.

	received(data: Uint8Array) {
		if (this.eof) return;
		this.chunks.push(data.slice());
		this.buffered += data.length;
		if (this.buffered > CHANNEL_WINDOW + CHANNEL_MAX_PACKET) {
			// The client ignored the window it was given.
			this.abort();
			return;
		}
		this.notify();
	}

	endOfInput() {
		this.eof = true;
		this.notify();
	}

	private notify() {
		const wake = this.wake;
		this.wake = null;
		wake?.();
	}

	/** The next chunk of input, or null once the client has sent EOF. */
	async read(): Promise<Uint8Array | null> {
		while (this.chunks.length === 0) {
			if (this.eof || this.aborted) return null;
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
		const chunk = this.chunks.shift() as Uint8Array;
		this.buffered -= chunk.length;
		this.consumed += chunk.length;
		// Let the client send more once half the window has been read.
		if (this.consumed >= CHANNEL_WINDOW / 2 && !this.closeSent) {
			this.server.sendChannelMessage(new Writer().byte(MSG.CHANNEL_WINDOW_ADJUST).uint32(this.remoteId).uint32(this.consumed).finish());
			this.consumed = 0;
		}
		return chunk;
	}

	/** Puts back the unread end of a chunk. */
	unread(chunk: Uint8Array) {
		if (chunk.length === 0) return;
		this.chunks.unshift(chunk);
		this.buffered += chunk.length;
		this.consumed -= chunk.length;
	}

	// Output to the client.

	windowAdjusted(bytes: number) {
		this.window = Math.min(this.window + bytes, 0xffffffff);
		const waiters = this.windowWaiters;
		this.windowWaiters = [];
		for (const w of waiters) w();
	}

	/** Sends output, waiting whenever the client's window is full. */
	write(data: Uint8Array): Promise<void> {
		return this.output(data, false);
	}

	stderr(text: string): Promise<void> {
		return this.output(new TextEncoder().encode(text), true);
	}

	private async output(data: Uint8Array, stderr: boolean) {
		let offset = 0;
		while (offset < data.length) {
			if (this.aborted || this.closeSent) throw new SshError("Channel closed");
			if (this.window === 0) {
				await new Promise<void>((resolve) => {
					this.windowWaiters.push(resolve);
				});
				continue;
			}
			const size = Math.min(data.length - offset, this.window, this.maxPacket);
			const chunk = data.subarray(offset, offset + size);
			const message = stderr
				? new Writer().byte(MSG.CHANNEL_EXTENDED_DATA).uint32(this.remoteId).uint32(1).string(chunk).finish()
				: new Writer().byte(MSG.CHANNEL_DATA).uint32(this.remoteId).string(chunk).finish();
			this.server.sendChannelMessage(message);
			this.window -= size;
			offset += size;
		}
	}

	/** Ends the command: its exit status, then EOF and close. */
	finish(status: number) {
		if (this.closeSent || this.aborted) return;
		this.server.sendChannelMessage(new Writer().byte(MSG.CHANNEL_REQUEST).uint32(this.remoteId).string("exit-status").bool(false).uint32(status).finish());
		this.server.sendChannelMessage(new Writer().byte(MSG.CHANNEL_EOF).uint32(this.remoteId).finish());
		this.server.sendChannelMessage(new Writer().byte(MSG.CHANNEL_CLOSE).uint32(this.remoteId).finish());
		this.closeSent = true;
	}

	closedByPeer() {
		if (!this.closeSent) {
			// Answer the close; whatever was running stops.
			this.server.sendChannelMessage(new Writer().byte(MSG.CHANNEL_CLOSE).uint32(this.remoteId).finish());
			this.closeSent = true;
		}
		this.abort();
	}

	abort() {
		if (this.aborted) return;
		this.aborted = true;
		this.controller.abort();
		this.notify();
		const waiters = this.windowWaiters;
		this.windowWaiters = [];
		for (const w of waiters) w();
		this.server.forgetChannel(this.localId);
	}
}

/** A fresh X25519 key pair's public key, and its shared secret with the client's public key. */
async function x25519Agree(clientPublic: Uint8Array): Promise<{ publicKey: Uint8Array; shared: Uint8Array }> {
	const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
	const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
	const peer = await crypto.subtle.importKey("raw", clientPublic, { name: "X25519" }, false, []).catch(() => {
		throw new SshError("Bad curve25519 public key");
	});
	// Workers' types call the peer key `$public`; the runtime takes the standard `public`.
	const algorithm = { name: "X25519", public: peer } as unknown as SubtleCryptoDeriveKeyAlgorithm;
	const shared = new Uint8Array(await crypto.subtle.deriveBits(algorithm, pair.privateKey, 256));
	if (shared.every((b) => b === 0)) throw new SshError("Bad curve25519 public key");
	return { publicKey, shared };
}

function incrementIv(iv: Uint8Array) {
	// The last 8 bytes are a big-endian invocation counter.
	for (let i = 11; i >= 4; i--) {
		iv[i] = (iv[i] + 1) & 0xff;
		if (iv[i] !== 0) break;
	}
}
