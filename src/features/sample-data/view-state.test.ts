import { expect, it } from "vitest";
import {
  gridPosition,
  rememberGridPosition,
  rememberGridView,
  releaseGridSession,
} from "./view-state";
it("restores independent table scroll/page/filter state and releases disconnected sessions", () => {
  rememberGridPosition("qa:a", 320, 980);
  rememberGridView("qa:a", 2, "value");
  rememberGridPosition("qa:b", 12, 30);
  expect(gridPosition("qa:a")).toEqual({
    top: 320,
    left: 980,
    page: 2,
    filter: "value",
  });
  expect(gridPosition("qa:b")).toEqual({
    top: 12,
    left: 30,
    page: 0,
    filter: "",
  });
  releaseGridSession("qa");
  expect(gridPosition("qa:a")).toEqual({
    top: 0,
    left: 0,
    page: 0,
    filter: "",
  });
});
