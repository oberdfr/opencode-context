import { defineConfig } from "vitest/config";

export default defineConfig({
  esbuild: {
    // The view uses OpenTUI's intrinsic elements (`<box>`, `<text>`), which come
    // from the OpenTUI Solid runtime rather than React's. Without this, vitest
    // compiles JSX with the React automatic runtime and evaluating any component
    // throws "React is not defined", so the dialog tree could not be tested.
    jsx: "automatic",
    jsxImportSource: "@opentui/solid",
  },
});
