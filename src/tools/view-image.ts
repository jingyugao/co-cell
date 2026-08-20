import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { tool } from "langchain";
import { z } from "zod";

const ViewImageInputSchema = z.object({
  path: z.string().min(1).describe("Local filesystem path to an image file."),
  detail: z
    .enum(["high", "original"])
    .optional()
    .describe(
      "Image detail level. Defaults to high; use original to preserve exact resolution.",
    ),
});

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function detectMimeType(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const prefix = bytes.subarray(0, 6).toString("ascii");
  if (prefix === "GIF87a" || prefix === "GIF89a") return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  if (bytes.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
  return undefined;
}

export async function createViewImageTool(options: {
  workspace: string;
  maxBytes?: number;
}) {
  const workspace = await realpath(resolve(options.workspace));
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  return tool(
    async ({ path, detail }) => {
      const candidate = await realpath(resolve(workspace, path));
      if (!isWithin(workspace, candidate)) {
        throw new Error(`image path is outside sandbox workspace: ${path}`);
      }
      const metadata = await stat(candidate);
      if (!metadata.isFile()) throw new Error(`image path is not a file: ${path}`);
      if (metadata.size > maxBytes) {
        throw new Error(`image exceeds ${maxBytes} byte limit: ${path}`);
      }
      const bytes = await readFile(candidate);
      const mimeType = detectMimeType(bytes);
      if (!mimeType) throw new Error("unsupported or invalid image file");
      const imageUrl = `data:${mimeType};base64,${bytes.toString("base64")}`;
      return [
        {
          type: "input_image",
          image_url: imageUrl,
          detail: detail ?? "high",
        },
      ];
    },
    {
      name: "view_image",
      description:
        "View a local image file from the filesystem when visual inspection is " +
        "needed. Use this for images already available inside the workspace.",
      schema: ViewImageInputSchema,
    },
  );
}
