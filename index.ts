// Root entrypoint.
//
// OpenCode resolves a local plugin directory by its root entrypoint file, so the
// implementation lives in src/ and this file re-exports it.
export { default } from "./src/index.ts";
