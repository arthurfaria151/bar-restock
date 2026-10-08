import { Capacitor } from "@capacitor/core";
import { Clipboard } from "@capacitor/clipboard";
import { Share } from "@capacitor/share";
import { AppLauncher } from "@capacitor/app-launcher";
import { Filesystem, Directory, Encoding } from "@capacitor/filesystem";

// Capacitor's iOS share plugin rejects when the share sheet is dismissed.
// Treat only that cancellation and the browser's AbortError as a normal result.
function isShareCancellation(error) {
  return error?.name === "AbortError" ||
    /^Share cancel(?:ed|led)$/i.test(String(error?.message || ""));
}

export function createNativeBridge({ clipboard, share, appLauncher, filesystem }) {
  let exportSequence = 0;
  return Object.freeze({
    async copyText(text) {
      await clipboard.write({ string: text });
    },
    async shareText({ title, text }) {
      try {
        return await share.share({ title, text, dialogTitle: title });
      } catch (error) {
        if (isShareCancellation(error)) return null;
        throw error;
      }
    },
    async shareJsonFile({ name, contents, title }) {
      // Accept a basename only. The export path always stays inside our cache
      // directory, and the original basename survives in Files and other apps.
      if (typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}\.json$/.test(name)) {
        throw new TypeError("A JSON export needs a plain .json filename");
      }
      if (typeof contents !== "string") throw new TypeError("JSON contents must be text");
      JSON.parse(contents);
      const folder = `bar-restock-exports/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${++exportSequence}`;
      try {
        const file = await filesystem.writeFile({
          path: `${folder}/${name}`,
          data: contents,
          directory: Directory.Cache,
          encoding: Encoding.UTF8,
          recursive: true,
        });
        try {
          return await share.share({ title, dialogTitle: title, files: [file.uri] });
        } catch (error) {
          if (isShareCancellation(error)) return null;
          throw error;
        }
      } finally {
        // Remove this request's file and folder after the share sheet closes.
        // A cache cleanup failure must not replace the actual export outcome;
        // iOS may also purge this temporary directory itself.
        await filesystem.rmdir({ path: folder, directory: Directory.Cache, recursive: true }).catch(() => {});
      }
    },
    async openMailto(url) {
      if (typeof url !== "string" || !url.startsWith("mailto:")) {
        throw new TypeError("Only mailto links can be opened by this bridge");
      }
      // openUrl reports the actual handoff result. Avoid a canOpenUrl query,
      // which would require an LSApplicationQueriesSchemes entry on iOS.
      const result = await appLauncher.openUrl({ url });
      if (!result.completed) throw new Error("No mail app could open the reminder");
    },
  });
}

if (typeof window !== "undefined" && Capacitor.isNativePlatform()) {
  window.BarRestockNative = createNativeBridge({
    clipboard: Clipboard,
    share: Share,
    appLauncher: AppLauncher,
    filesystem: Filesystem,
  });
}
