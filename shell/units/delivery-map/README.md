# delivery-map

Realm unit: the search box's position toggle (`mode: locate`) and the
delivery map (`mode: map`), whose pin moves only when taken. It raises only
`pin` (`latitude`, `longitude`, `source: gps|map`, or all three empty when the
reader turns their position off); the toggle reads as on while `near` holds
the reader's position. A refused or failed fix names the toggle, from the
`denied` / `unavailable` props. Tiles come from the OpenFreeMap `liberty`
style. Test: `map_test.ts`.

## Vendored

MapLibre GL JS **5.24.0**, the classic UMD build: 6.x ships ESM with module
workers, which an opaque-origin sandbox cannot start; 5.x spawns its worker
from a blob URL. Taken from the npm tarball, checked against the registry's
`dist.integrity`
`sha512-ALyFxgtd5R+65UqZ/++lOqwWcC0SNho9c27fYSyLmG7AfnAul2o46F05aDJGPbFU57wos9dgcIySHs0Xe6ia3A==`.

| file | from | sha256 |
| --- | --- | --- |
| `vendor/maplibre-gl.js` | `dist/maplibre-gl.js` | `45a9b07a9189ce56054c620a947ccf41e291e58c95e9b61533b740aaa65ee5cb` |
| `vendor/maplibre-gl.css` | `dist/maplibre-gl.css` | `ab1e70d59ec40465bae7e7030da2f3ccf28133fd502e62bd598eefbadfd7a732` |
| `vendor/LICENSE.txt` | `LICENSE.txt` | `ee5fc05a0677eaf69601d2c7db0d9ecd6cc27c3abc1d0733bc9ed34707cf8ef2` |
