import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api, keys, type ProjectEvent } from "./api.ts";

export type LiveStatus = "connecting" | "live" | "offline";

export interface Live {
	status: LiveStatus;
	events: ProjectEvent[];
	/** Task id → when an event last touched it, for highlighting fresh changes. */
	touched: Map<string, number>;
}

export const LiveContext = createContext<Live>({ status: "connecting", events: [], touched: new Map() });
export const useLive = () => useContext(LiveContext);

const FEED_LIMIT = 300;

/**
 * Loads the newest events, then streams the rest over the project WebSocket (resuming from the last
 * seen seq after a reconnect) and invalidates the queries each event affects.
 */
export function useProjectLive(project: string): Live {
	const queryClient = useQueryClient();
	const history = useQuery({ queryKey: keys.events(project), queryFn: () => api.events(project, FEED_LIMIT), staleTime: Infinity });
	const [status, setStatus] = useState<LiveStatus>("connecting");
	const [touched, setTouched] = useState(() => new Map<string, number>());
	const lastSeq = useRef(0);

	const loaded = history.data !== undefined;
	useEffect(() => {
		if (!loaded) return;
		lastSeq.current = Math.max(lastSeq.current, history.data?.at(-1)?.seq ?? 0);
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let ping: ReturnType<typeof setInterval> | undefined;
		let attempts = 0;
		let closed = false;
		let reconnecting = false;
		const invalidate = batchInvalidate(queryClient);

		const connect = () => {
			setStatus("connecting");
			socket = new WebSocket(api.liveUrl(project, lastSeq.current));
			socket.onopen = () => {
				attempts = 0;
				setStatus("live");
				// The replay covers missed events; refetch everything else that may have moved meanwhile.
				if (reconnecting) invalidate(["project", project]);
				reconnecting = true;
				ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), 30_000);
			};
			socket.onmessage = (msg) => {
				if (msg.data === "pong") return;
				const event = JSON.parse(msg.data as string) as ProjectEvent;
				if (event.seq <= lastSeq.current) return;
				lastSeq.current = event.seq;
				queryClient.setQueryData<ProjectEvent[]>(keys.events(project), (prev = []) => [...prev, event].slice(-FEED_LIMIT));
				if (event.taskId) {
					const id = event.taskId;
					setTouched((prev) => new Map(prev).set(id, Date.now()));
					invalidate(keys.task(project, id));
				}
				invalidate(keys.project(project), true);
				invalidate(keys.tasks(project));
				invalidate(keys.queue(project));
				invalidate(keys.projects);
				if (event.type === "main.advanced") {
					invalidate(["project", project, "log"]);
					invalidate(keys.code(project));
					invalidate(keys.branches(project));
				}
			};
			socket.onclose = () => {
				clearInterval(ping);
				if (closed) return;
				setStatus("offline");
				retry = setTimeout(connect, Math.min(1000 * 2 ** attempts++, 15_000));
			};
		};
		connect();
		return () => {
			closed = true;
			clearTimeout(retry);
			clearInterval(ping);
			socket?.close();
		};
	}, [project, loaded, queryClient]);

	return { status, events: history.data ?? [], touched };
}

/** Coalesces bursts of events (eight agents merging at once) into one refetch per query. */
function batchInvalidate(queryClient: QueryClient) {
	const pending = new Map<string, { queryKey: readonly unknown[]; exact: boolean }>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	return (queryKey: readonly unknown[], exact = false) => {
		pending.set(JSON.stringify([queryKey, exact]), { queryKey, exact });
		timer ??= setTimeout(() => {
			timer = undefined;
			for (const filter of pending.values()) void queryClient.invalidateQueries(filter);
			pending.clear();
		}, 150);
	};
}
