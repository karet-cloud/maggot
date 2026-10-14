import { createSerializationAdapter } from "@tanstack/react-router";
import { createStart } from "@tanstack/react-start";
import { ApiError } from "./lib/api.ts";

// Errors from server-rendered queries reach the browser as ApiErrors, so pages tell a 404 from the rest.
const apiError = createSerializationAdapter({
	key: "maggot-api-error",
	test: (value): value is ApiError => value instanceof ApiError,
	toSerializable: (e) => ({ status: e.status, code: e.code, message: e.message }),
	fromSerializable: (e) => new ApiError(e.status, e.code, e.message),
});

export const startInstance = createStart(() => ({ serializationAdapters: [apiError] }));
