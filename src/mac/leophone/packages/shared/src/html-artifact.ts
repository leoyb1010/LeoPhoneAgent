import { z } from "zod";

export const HTML_ARTIFACT_MAX_BYTES = 1024 * 1024;
export const htmlArtifactPreviewRequestSchema = z
  .object({
    html: z.string().max(HTML_ARTIFACT_MAX_BYTES),
    interactive: z.boolean(),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(value.html).byteLength <= HTML_ARTIFACT_MAX_BYTES,
    "HTML preview is too large",
  );
export type HtmlArtifactPreviewRequest = z.infer<typeof htmlArtifactPreviewRequestSchema>;
export interface HtmlArtifactPreviewHandle {
  id: string;
  url: string;
}
export interface HtmlArtifactPreviewPort {
  create(request: HtmlArtifactPreviewRequest): Promise<HtmlArtifactPreviewHandle>;
  release(id: string): Promise<void>;
}

export function buildHtmlArtifactCsp(interactive: boolean): string {
  return `default-src 'none'; script-src ${interactive ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`;
}
