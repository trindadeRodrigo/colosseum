# Token artwork

Verified token marks, served locally as transparent PNGs for asset identification. Original artwork and colours are preserved; these marks are not partnership badges. Unknown assets and failed image loads keep the ticker fallback. Visible names and shares remain the accessible labels.

| Token | File | Official evidence | Original asset |
|---|---|---|---|
| jlUSDC (Jupiter Lend) | jlusdc.png | https://jup.ag/tokens/9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D | https://cdn.instadapp.io/solana/tokens/icons/usdc.png |
| syrupUSDC (Maple) | syrupusdc.png | https://maple.finance/transparency | Inline SVG beside the syrupUSDC label; its unchanged paths rasterized to transparent 512×512 PNG using sharp 0.35.4 / librsvg 2.62.91 |
| PAX Gold (Paxos) | paxg.png | https://www.paxos.com/brand-resources | https://framerusercontent.com/images/7OsnaCpXxdzsKLShNVmad8O1Ys.png |

Artwork belongs to the respective providers: Jupiter, Maple and Paxos. Retrieved October 7, 2026. The Maple source SVG is retained beside the PNG. Its three paths were rechecked against the official transparency page on October 7, 2026; all matched exactly. The source contains a title and paths only, without scripts, event handlers, embedded images or external resources. Conversion uses `sharp("syrupusdc.svg", { density: 1536 }).resize(512, 512).png()`; the artwork colours and geometry are unchanged. All three served PNGs decode at 512×512 with transparent pixels.

SHA-256:

- jlusdc.png: dc1eba27655a73b7420f736a53127cff70b603336c48dcc9c12d1e8742b47c77
- syrupusdc.png: fd5e60afefe8e9c209587769e9fe1dced0120826a261cf8cb0ed015cdb22d4fe
- syrupusdc.svg (source): 84394a230ec8564d24b2eba188395d82577625cc8e765e7a3760a03dc0e6ed64
- paxg.png: 0db15d4ea8f3ee8ed713a9e04dd7ef34222e8ccc7e9b3a8b5abb5ffc432b3dd3

## Decision, and what is still text

Thom, 2026-10-09: a token shows its issuer's own artwork where the token has it, otherwise the company's or fund's official mark; unaltered, on the neutral tile `AssetMark` draws, with the ticker as the fallback. Files are kept here and keyed by the token's name as `tokenName` gives it, so a test token (`tSPYx`) and the token it stands in for (`SPYx`) show one picture. Every screen draws a holding through `AssetMark` (`features/order/PlanView.tsx`), so a token has one face.

No file has been added since Oct 7. These assets still show their ticker, and each needs a file fetched from the source named, by a person or with a person's word in the session that fetches it, with the URL and date added to the table above:

| Assets | Where the artwork should come from |
|---|---|
| SPYx, QQQx, NVDAx, TSLAx, AAPLx, METAx, MSFTx, AMZNx, GOOGLx, MSTRx, CRCLx, GLDx (Solana; and their `t…x` test tokens) | the xStocks issuer's own token images (its product pages or token metadata) |
| AAPL, MSFT, NVDA, TSM, SPY, GLD, SGOV (Robinhood Chain) | the token issuer's artwork if it publishes any; otherwise each company's or fund's brand or press kit |
| USDC | Circle's brand kit |
| USDG, tUSDG | the issuer's brand resources |
| USDY | Ondo's brand resources |
| JitoSOL, JUP | Jito's and Jupiter's brand kits |
| syrupUSDT | Maple, as syrupUSDC above |
| mYield, BRLx, the sample asset | none: not real tokens, they keep the ticker |
