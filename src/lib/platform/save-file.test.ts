import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  save: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: mocks.isTauri }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeTextFile: mocks.write }));
import { saveExportFile } from "./save-file";
beforeEach(() => {
  vi.clearAllMocks();
});
describe("file export", () => {
  it("writes only the path chosen in the desktop save dialog", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.save.mockResolvedValue("/chosen/workspace.json");
    await saveExportFile("demo/name", "json", '{"version":1}');
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "demo_name.json" }),
    );
    expect(mocks.write).toHaveBeenCalledWith(
      "/chosen/workspace.json",
      '{"version":1}',
    );
  });
  it("does not write when the save dialog is cancelled", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.save.mockResolvedValue(null);
    await saveExportFile("demo", "json", "{}");
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("propagates native save failures to the application", async () => {
    mocks.isTauri.mockReturnValue(true);
    mocks.save.mockResolvedValue("/chosen/workspace.json");
    mocks.write.mockRejectedValueOnce(Error("Disk full"));
    await expect(saveExportFile("demo", "json", "{}")).rejects.toThrow(
      "Disk full",
    );
  });
});
