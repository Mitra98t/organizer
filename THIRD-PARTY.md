# Third-party software

Organizer is licensed under the GNU Affero General Public License v3.0 (see [LICENSE](LICENSE)).
It ships, unmodified, the following libraries in `public/vendor/`. Each keeps its own license, whose full text sits next to it.

| Library | Version | License | Source | Used for |
|---|---|---|---|---|
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.4.299 | Apache-2.0 (cmaps, standard fonts and wasm decoders under their own licenses, see `public/vendor/pdfjs/`) | https://github.com/mozilla/pdf.js | PDF viewer and text search |
| [three.js](https://github.com/mrdoob/three.js) | 0.186.1 | MIT | https://github.com/mrdoob/three.js | 3D model viewer (STL, 3MF, STEP); addons from `examples/jsm` with relative imports |
| [fflate](https://github.com/101arrowz/fflate) (bundled with three.js) | — | MIT | https://github.com/101arrowz/fflate | 3MF decompression |
| [occt-import-js](https://github.com/kovacsv/occt-import-js) | 0.0.23 | LGPL-2.1 (Open CASCADE Technology) | https://github.com/kovacsv/occt-import-js | STEP import (WebAssembly) |
| [dxf-parser](https://github.com/gdsestimating/dxf-parser) | 1.1.2 | MIT | https://github.com/gdsestimating/dxf-parser | DXF drawings |

occt-import-js and Open CASCADE are distributed under the LGPL-2.1 as an unmodified, separately loaded WebAssembly module: their source code is available at the links above, and you may replace `public/vendor/occt/` with your own build.
