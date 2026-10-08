# iOS Asset Forge

A static, GitHub Pages-friendly image utility that turns one source image into four iOS-ready assets:

- Full Screen — 1320 × 2868 (9:19.5)
- Hero — 1536 × 2048 (3:4)
- Square — 1024 × 1024 (1:1)
- Texture — 2048 × 2048 seamless tile

## AI upscaling

When AI mode is set to **Auto**, the app runs Real-ESRGAN only when the cropped source is smaller than the requested output. In modern Chromium browsers it attempts WebGPU first and falls back to WebAssembly/CPU if needed.

The app uses ONNX Runtime Web and a public browser-ready Real-ESRGAN ONNX model. The image itself remains in the browser; no application backend or API key is required.

## Run locally

Because this is a static site, any HTTP server will work. For example:

```bash
python3 -m http.server 8080
```

Then open:

http://localhost:8080

Opening the file directly with `file://` is not recommended because browser security can block model/network requests.

## GitHub Pages

Upload the contents of this folder to a repository and enable **Settings → Pages → Deploy from branch → main / root**. The site can run without a build step.

## Third-party software / model notices

- ONNX Runtime Web — MIT
- Real-ESRGAN weights — BSD 3-Clause
- JSZip — MIT

See `licenses/REAL_ESRGAN_BSD_3_CLAUSE.txt` for the model attribution notice.


### Performance update
This version uses the compact Real-ESRGAN general x4v3 model (~4.6 MB) instead of the 32 MB x4plus FP16 model. The model is downloaded only when AI is actually needed, shows download progress, prefers WebGPU, and falls back to WASM. Auto mode uses AI only when the source crop is materially below the required output size; otherwise it uses high-quality browser resizing for speed.

## Texture behavior (v4)
The Texture preset is deliberately different from the photo presets. It does not call Real-ESRGAN and it never mirrors the image into quadrants. It chooses a quiet, even-detail square crop, shifts the wrap seam to the center, feathers the seam with a soft blend, and then scales to 2048×2048. This preserves photographic character and avoids the synthetic mirrored look.

For the Stele brief, `bg_marble` should ideally be generated from a dedicated marble source image; a coastal hero photograph should not be algorithmically turned into white marble.
