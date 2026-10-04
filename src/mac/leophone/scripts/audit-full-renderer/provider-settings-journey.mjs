import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function auditProviderSettings({ page, output, capture }) {
  const samples = [];
  for (const label of ["Custom providers", "Base URL", "API format", "API key", "Model list",
    "No models are configured. Add a model to use it in chat."]) {
    const element = page.getByText(label, { exact: true }).first();
    await element.waitFor();
    samples.push(await element.evaluate((element, label) => {
      const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      const rgba = color => {
        context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1);
        return Array.from(context.getImageData(0, 0, 1, 1).data);
      };
      const layers = [];
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        layers.push({ tag: node.tagName, background: style.backgroundColor, rgba: rgba(style.backgroundColor), opacity: style.opacity });
      }
      let background = [255, 255, 255];
      for (const layer of [...layers].reverse()) {
        const alpha = layer.rgba[3] / 255;
        background = background.map((value, index) => alpha * layer.rgba[index] + (1 - alpha) * value);
      }
      const style = getComputedStyle(element), foreground = rgba(style.color);
      const painted = background.map((value, index) => foreground[3] / 255 * foreground[index] + (1 - foreground[3] / 255) * value);
      const luminance = color => color.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
        .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const values = [luminance(painted), luminance(background)].sort((a, b) => b - a);
      return { label, color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight,
        layers, foregroundRGBA: foreground, backgroundRGB: background,
        opaqueLayerContrast: (values[0] + .05) / (values[1] + .05),
        opacityAssumptionSatisfied: layers.every(layer => Number(layer.opacity) === 1) };
    }, label));
  }
  await writeFile(resolve(output, "provider-computed-contrast.json"), JSON.stringify({ samples,
    scope: "Computed text and ancestor solid-background colors; gradients/backdrop imagery and complete accessibility compliance are not inferred." }, null, 2));

  const navigationTitle = samples.find(sample => sample.label === "Custom providers");
  assert.ok(navigationTitle.opacityAssumptionSatisfied, "Navigation contrast requires opaque ancestor layers");
  assert.ok(navigationTitle.opaqueLayerContrast >= 4.5,
    `Custom providers navigation label contrast is ${navigationTitle.opaqueLayerContrast}:1`);
  await capture("provider-readable-navigation-label");

  const baseURL = page.getByTestId("model-provider-base-url-input");
  const syntheticURL = "https://models.example.invalid/v1";
  await baseURL.fill(syntheticURL); await baseURL.press("Tab");
  await page.getByTestId("settings-section-nav-general").click();
  await page.getByTestId("settings-section-nav-modelProvider").click();
  await baseURL.waitFor(); assert.equal(await baseURL.inputValue(), syntheticURL);
  await capture("provider-synthetic-url-survives-navigation");
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.waitFor();
  const modelID = dialog.getByRole("textbox", { name: "Model ID", exact: true });
  await modelID.fill("synthetic-cancelled-model");
  await capture("provider-add-model-draft-before-cancel");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await page.getByText("No models are configured. Add a model to use it in chat.", { exact: true }).waitFor();
  assert.equal(await page.locator('[data-testid^="model-provider-model-input-"]').count(), 0);
  await page.getByRole("button", { name: "Add model", exact: true }).click();
  await dialog.waitFor(); assert.equal(await modelID.inputValue(), "");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  await capture("provider-cancel-reopen-keeps-model-list-empty");
}
