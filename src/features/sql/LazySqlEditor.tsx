import { lazy, Suspense, type ComponentProps } from "react";

const Editor = lazy(() =>
  import("./Editor").then((module) => ({ default: module.SqlEditor })),
);

export function SqlEditor(props: ComponentProps<typeof Editor>) {
  return (
    <Suspense
      fallback={
        <div className="empty-state" role="status">
          Loading SQL editor…
        </div>
      }
    >
      <Editor {...props} />
    </Suspense>
  );
}
