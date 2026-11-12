# Vela gallery fonts

The interface is offline capable. Font files are bundled assets; the application
does not fetch fonts from a CDN. Manrope and Noto Sans SC provide real variable
weights for controls and Chinese text. Noto Serif SC is restricted to page titles
and empty states. Playfair Display remains the existing wordmark face.

The three variable source files came from the Google Fonts repository:

- `ofl/manrope/Manrope[wght].ttf`
- `ofl/notosanssc/NotoSansSC[wght].ttf`
- `ofl/notoserifsc/NotoSerifSC[wght].ttf`

All three use SIL OFL 1.1; the adjacent `*-LICENSE.txt` files include their
copyright notices and full terms. Original TTF files are build inputs rather than
shipped duplicates. This machine keeps them in `reports/gallery-font-sources`.
The legacy Inter files remain in the repository but are not referenced by the UI.

## Rebuild

Install `fonttools[woff]==4.60.1` and `brotli==1.2.0` in a build environment, supply
the exact source files below, then run:

```powershell
python scripts/prepare-gallery-fonts.py --source-dir reports/gallery-font-sources
```

The script verifies all source hashes before writing output and preserves font
timestamps for reproducibility. Manrope and Noto Sans SC keep their complete
character coverage. The serif face includes characters in all bundled locales,
Latin, Cyrillic, general punctuation, and CJK punctuation. Regenerate it when
adding translated page titles. Missing characters fall back to the system serif.

| Input file | SHA-256 |
| --- | --- |
| manrope-variable.ttf | `3ae11c49db0455a3cc33e37d380f20fdb8c7f8b41dc07625c177e3d87a9d6ae6` |
| noto-sans-sc-variable.ttf | `a3041811a78c361b1de50f953c805e0244951c21c5bd412f7232ef0d899af0da` |
| noto-serif-sc-variable.ttf | `050080d9255a86808f2945bffac582b31ef32bc36411ce29563b4961670c66f9` |

| Shipped file | SHA-256 |
| --- | --- |
| manrope-variable.woff2 | `30b83738add8c9edd9e3450b98036a9a8fb5668d0cbd4eb0ce5fe6761197f21f` |
| noto-sans-sc-variable.woff2 | `aef8c34277afad81ecd0227138a830263c0caea65b7aea66d1195395f097b55a` |
| noto-serif-sc-variable.woff2 | `029f6a5f356b892f28f6b953f9fde3a451cd17d6545504cb17b8acb965bef61b` |
