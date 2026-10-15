import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { test } from "node:test";
import { reservedName, ROUTE_NAMES, routeName, usernameShape, validUsername } from "../src/names.ts";

/** The first URL segment of each file route that has a fixed one (not `$owner`, the root or the index). */
function topLevelSegments(): string[] {
	const files = readdirSync(new URL("../app/routes/", import.meta.url)).filter((f) => f.endsWith(".tsx"));
	const segments = files.map((f) => f.replace(/\.tsx$/, "").split(".")[0]).filter((s) => !s.startsWith("$") && !s.startsWith("__") && s !== "index");
	return [...new Set(segments)];
}

test("the route names are exactly the top-level segments in app/routes, and all reserved", () => {
	assert.deepEqual(topLevelSegments().sort(), [...ROUTE_NAMES].sort());
	for (const name of ROUTE_NAMES) assert.ok(reservedName(name) && routeName(name.toUpperCase()), name);
});

test("reserved names are refused whatever their case", () => {
	for (const name of ["settings", "Settings", "EXPLORE", "Api", "new", "orgs", "notifications", "parity", "admin", "help", "docs", "static", "assets"]) {
		assert.ok(reservedName(name), name);
	}
	assert.equal(validUsername("settings"), false);
	assert.equal(validUsername("explore"), false);
	assert.equal(reservedName("settings-fan"), false);
});

test("usernames: shape, and reserved names only refused for new accounts", () => {
	assert.ok(validUsername("ada"));
	assert.ok(validUsername("ada-lovelace"));
	assert.equal(validUsername("ada--lovelace"), false);
	assert.equal(validUsername("-ada"), false);
	assert.equal(validUsername("Ada"), false);
	// Sign-ins check only the shape, so an account whose name became reserved later can still sign in.
	assert.ok(usernameShape("settings"));
});
