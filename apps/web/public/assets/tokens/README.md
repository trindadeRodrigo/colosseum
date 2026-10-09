# Token artwork

Verified token marks, served locally as transparent PNGs for asset identification. Original artwork and colours are preserved; these marks are not partnership badges. Unknown assets and failed image loads keep the ticker fallback. Visible names and shares remain the accessible labels.

| Token | File | Official evidence | Original asset |
|---|---|---|---|
| jlUSDC (Jupiter Lend) | jlusdc.png | https://jup.ag/tokens/9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D | https://cdn.instadapp.io/solana/tokens/icons/usdc.png |
| syrupUSDC (Maple) | syrupusdc.png | https://maple.finance/transparency | Inline SVG beside the syrupUSDC label; its unchanged paths rasterized to transparent 512×512 PNG using sharp 0.35.4 / librsvg 2.62.91 |
| PAX Gold (Paxos) | paxg.png | https://www.paxos.com/brand-resources | https://framerusercontent.com/images/7OsnaCpXxdzsKLShNVmad8O1Ys.png |
| SPYx (xStocks, Backed) | spyx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/SPYx.png |
| QQQx (xStocks, Backed) | qqqx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/QQQx.png |
| NVDAx (xStocks, Backed) | nvdax.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png |
| TSLAx (xStocks, Backed) | tslax.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png |
| AAPLx (xStocks, Backed) | aaplx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/AAPLx.png |
| GOOGLx (xStocks, Backed) | googlx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/GOOGLx.png |
| METAx (xStocks, Backed) | metax.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/METAx.png |
| MSFTx (xStocks, Backed) | msftx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/MSFTx.png |
| AMZNx (xStocks, Backed) | amznx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/AMZNx.png |
| SPCXx (xStocks, Backed) | spcxx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/SPCXx.png |
| MSTRx (xStocks, Backed) | mstrx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/MSTRx.png |
| CRCLx (xStocks, Backed) | crclx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/CRCLx.png |
| HOODx (xStocks, Backed) | hoodx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/HOODx.png |
| COINx (xStocks, Backed) | coinx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/COINx.png |
| PLTRx (xStocks, Backed) | pltrx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/PLTRx.png |
| GLDx (xStocks, Backed) | gldx.png | The `image` of the token's on-chain metadata, on the issuer's host | https://xstocks-metadata.backed.fi/logos/tokens/GLDx.png |
| USDG, tUSDG (Global Dollar, Paxos) | usdg.png | https://globaldollar.com/brand ("USDG Token Logo") | https://framerusercontent.com/images/CtEQkwH2xKYB2x8WTHX8Zja9d4.png, 1000×1001, resized to 511×512 |
| USDY (Ondo) | usdy.png | https://ondo-finance.notion.site/Ondo-Media-Kit-3bc0a5aced014cc4b0ef62f1638bbf8e ("Ondo Funds", linked from ondo.finance) | `USDY-token.svg`: https://s3-us-west-2.amazonaws.com/secure.notion-static.com/db119537-95ef-40ab-83a7-8df48b4d8bed/USDY-token.svg, served through the kit page |
| syrupUSDT (Maple) | syrupusdt.png | https://maple.finance/transparency | Inline SVG beside the syrupUSDT label |
| syrupUSDG (Maple) | syrupusdg.png | https://maple.finance/transparency | Inline SVG beside the syrupUSDG label |
| JUP (Jupiter) | jup.png | The `image` of the on-chain metadata of mint `JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN`, on Jupiter's host | https://static.jup.ag/jup/icon.png |
| SOL (Solana) | sol.png | https://solana.com/branding ("Logomark") | https://solana.com/src/img/branding/solanaLogoMark.svg |

Artwork belongs to the respective providers: Jupiter, Maple and Paxos. Retrieved October 7, 2026. The Maple source SVG is retained beside the PNG. Its three paths were rechecked against the official transparency page on October 7, 2026; all matched exactly. The source contains a title and paths only, without scripts, event handlers, embedded images or external resources. Conversion uses `sharp("syrupusdc.svg", { density: 1536 }).resize(512, 512).png()`; the artwork colours and geometry are unchanged. All three served PNGs decode at 512×512 with transparent pixels.

Added October 9, 2026 (Thom: tokens show the issuer's own artwork, else the company's or fund's official mark, unaltered, used to identify the asset). These are third-party marks, shown only to identify the asset; they belong to Backed Finance and the companies and funds whose marks its token images carry, Paxos, Ondo, Maple, Jupiter and the Solana Foundation. All retrieved October 9, 2026.

- The xStocks images are the issuer's own picture for each token, as its on-chain metadata names it; the `image` field was read on chain for SPYx (`XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W`), QQQx (`Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ`) and NVDAx (`Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh`), and the others were taken from the same host by symbol. They are the issuer's 400×400 opaque tiles, byte for byte. The terms of the xstocks.fi website reserve its content and grant no right in any logo; the files here come from the token metadata, which is published for showing the token, not from the website.
- usdg.png is the kit's PNG, resized only. jup.png is the 256×256 file, byte for byte.
- usdy.svg, syrupusdt.svg, syrupusdg.svg and sol.svg are kept beside their PNGs. Each was read as text: paths, a clip path or a gradient referenced inside the file, no scripts, event handlers, embedded images or external resources. Conversion is the one above (sharp 0.35.5 / librsvg 2.63.2). The Solana logomark is not square, so it sits whole inside the round frame with clear space around it: `sharp("sol.svg", { density: 1536 }).resize(352, 352, { fit: "contain" }).extend(80)`, transparent.
- Every file was looked at on the light and the dark tile; none needed an alternate version.

Tokens that keep their ticker, and why, are the `NO_ARTWORK` list in `features/order/asset-logos.ts`; `asset-logos.test.ts` fails for a listed token that is in neither list. In short: USDC (Circle's Brand Use Policy: "Circle does not permit any use of its Brand Assets for commercial purposes", and its kit is a zip); JitoSOL (no brand kit found, and the on-chain image sits on a generic storage host); cbBTC and cbETH (Coinbase asks for consent); and Robinhood Chain's stock and fund tokens, which have no artwork of their own: Apple, Microsoft, NVIDIA, Google, Amazon and Meta allow their logos only under a licence or with approval, Circle's own marks need written authorisation, and for Tesla, Strategy, SpaceX, TSMC and the funds' sponsors (State Street for SPY and GLD, Invesco for QQQ, iShares for SGOV) no brand kit was found that offers a mark for this use.

SHA-256:

- jlusdc.png: dc1eba27655a73b7420f736a53127cff70b603336c48dcc9c12d1e8742b47c77
- syrupusdc.png: fd5e60afefe8e9c209587769e9fe1dced0120826a261cf8cb0ed015cdb22d4fe
- syrupusdc.svg (source): 84394a230ec8564d24b2eba188395d82577625cc8e765e7a3760a03dc0e6ed64
- paxg.png: 0db15d4ea8f3ee8ed713a9e04dd7ef34222e8ccc7e9b3a8b5abb5ffc432b3dd3
- spyx.png: 83c5db1a3c9d82482b9422bf1f850f1efe8af0ca9ed9455cb71f7830ad16b5c4
- qqqx.png: ef8778ce76e2300a44cc6bd6a263336d9dac6acbfff4f09da1e8a419e7c87ee6
- nvdax.png: 6b639eff0158850c474d378ed8580375c396dda494cfff9040e6b1735b8ef623
- tslax.png: 42cb949ac9a7e6385df10a59bcd47576260c6a78bf54df0eea962343644d7fd8
- aaplx.png: 930db19951493787ee286650222311b5158317bdb811205b450cfb412ab89295
- googlx.png: b9240e1eb8a5174f437d82eb7852e54f318ae05f55409be38df3b851f9a8e876
- metax.png: 52cb2a0719cdc068ccccc28ba2f6451d4db43e48734a2e7832da7e66b0d7e806
- msftx.png: 254e57a4c746213c9773c00933ab360ff81ba023c3cc7ed9f2a3fd5224e4e3c2
- amznx.png: dbf6bfee7c8cd38e53a9191a5a3df6bbd69690c84a39330228b8cbe203f0d478
- spcxx.png: cf54500376d08d55e7b8a8508ea6b02a18d3f665ed0fb7f3fcd6fe8697a0029d
- mstrx.png: 1456e378930a91691694252aef4c77d0b56eb296802a9b1396a4a92629a449a8
- crclx.png: fbd0e30678880d808e69193523f84de0e02b1d1ba487447d5777a698aa4cec8c
- hoodx.png: aa5cb6f961da95ca81791268e5c0f7e5e309c8156303920c6c45b74aa1e49d2a
- coinx.png: 7b028dd209022659803a269eb4a35f61995249e9e2c17635ffe2db41eefce6d6
- pltrx.png: edada1087693ec0de61c5386c0a166617b8b140658d6532326133a563441fd6e
- gldx.png: 76ee29e811b22b2a2f8082d780c8c93442219a6a95d4db189bcf06343cbde448
- usdg.png: 9bd1c0785516b2113ada92066fc710539233409741e0bf701cbecaeb4c256169
- usdy.png: 8a61f71fc332bc80d64796e7da876512475fe6163e69c2f262fc2c97c662784e
- usdy.svg (source): a7e114b688c62af7c26e45a5452e7d836eca84f78e7797e9293de17f674c4096
- syrupusdt.png: eb253765c1f6c99dfdb9f6a1475d35049563ab5c7e49472ad7e3378be7826602
- syrupusdt.svg (source): eeb9122ad5ad95a78ead864569ca52b7728559b687b33a0e0862b57601779b01
- syrupusdg.png: f380dcf31461dab5cb2c6c5d93d5688102268243c4a5dd7a098882c92b184b62
- syrupusdg.svg (source): 617b71796fb0c72c6a9a78ef441f9972742439f41a88b7d7a673524a5e169b69
- jup.png: 5f460c59d968c0af5a4dee3e19c5e51f0298f15ae3fac907e9e4c0904bec7506
- sol.png: 6dbe58a11a904b798faea5a0073bee2078893bcd5af9649d0b4a93bdda727665
- sol.svg (source): 3d3401109aa061dec40a8659f1847817a8e647f98de1e65e76e86a95bbe1f08a
