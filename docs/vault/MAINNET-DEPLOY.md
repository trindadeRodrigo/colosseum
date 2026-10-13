# Robinhood Chain mainnet: the deploy of 2026-10-12

Thom sent every transaction, from `0x04957c813932b659a9da3b7ea2e320c1073a8938`, with `contracts/script/Deploy.s.sol` and `contracts/script/config/4663.json` at commit `f3b39813`. No agent signed or sent anything. Chain id 4663, 40 transactions, blocks 86877019 to 86877432, total paid 0.000346854520252 ETH. The record is [`deployments/robinhood-mainnet.json`](../../deployments/robinhood-mainnet.json), written by `pnpm ops:mainnet-records` from forge's broadcast file and held to the chain by `pnpm ops:authority-check` (verdict OK, 2026-10-12).

State after it: nine stock and fund tokens and USDG listed, keeper zero and off, no deposit cap, not launched, no deposit made. The timelock waits 172800 s (48 hours); the Safe is 2 of 2 and holds the three roles; the deployer holds none.

| What | Address |
|---|---|
| Factory (proxy) | [`0xae4ae2f2a5c2ee50c5a7574cf355cd5b068e7a80`](https://robinhoodchain.blockscout.com/address/0xae4ae2f2a5c2ee50c5a7574cf355cd5b068e7a80) |
| Registry (proxy) | [`0xee6baaec7ec5cd946dad57e1edb3f10c794c8afc`](https://robinhoodchain.blockscout.com/address/0xee6baaec7ec5cd946dad57e1edb3f10c794c8afc) |
| Beacon | [`0xac27328a77962cd0b6095e7c4074946622d6d77d`](https://robinhoodchain.blockscout.com/address/0xac27328a77962cd0b6095e7c4074946622d6d77d) |
| Vault logic | [`0x16c06e495bd685ac55502f1c699a52762e32d855`](https://robinhoodchain.blockscout.com/address/0x16c06e495bd685ac55502f1c699a52762e32d855) |
| Factory logic | [`0x95c04d3f271b901784ee19997e7dbe4bf1dbba16`](https://robinhoodchain.blockscout.com/address/0x95c04d3f271b901784ee19997e7dbe4bf1dbba16) |
| Registry logic | [`0x666439873b2b4121b290dc91fb82308e1e760646`](https://robinhoodchain.blockscout.com/address/0x666439873b2b4121b290dc91fb82308e1e760646) |
| Timelock (admin of the factory, owner of the beacon) | [`0x749f6aeb956b9f490e316599068ba8a6bd248342`](https://robinhoodchain.blockscout.com/address/0x749f6aeb956b9f490e316599068ba8a6bd248342) |
| Safe (proposer, canceller, executor) | [`0x4568bc6cc821b34095059fd46102eaa22a675fdc`](https://robinhoodchain.blockscout.com/address/0x4568bc6cc821b34095059fd46102eaa22a675fdc) |
| Guardian | [`0x0a1c3312c808b23d019bf241028f6b5624f4cc98`](https://robinhoodchain.blockscout.com/address/0x0a1c3312c808b23d019bf241028f6b5624f4cc98) |

| # | Block | Transaction | What |
|---|---|---|---|
| 1 | 86877019 | [`0x20950289dd960300616007db8c21b0afcbccabf50a7f79f2350463569cc1e902`](https://robinhoodchain.blockscout.com/tx/0x20950289dd960300616007db8c21b0afcbccabf50a7f79f2350463569cc1e902) | create BasketVault |
| 2 | 86877026 | [`0x9f7fb0fe6937a40791b735e6d2d03c71ad453c8dd7e06fec6fb056ec74b03e4e`](https://robinhoodchain.blockscout.com/tx/0x9f7fb0fe6937a40791b735e6d2d03c71ad453c8dd7e06fec6fb056ec74b03e4e) | create VaultBeacon |
| 3 | 86877033 | [`0xb4aaf1349d46225b2b0567d3f0869ce1acdb11f4ab8d2c7b2e55f52e57b7684d`](https://robinhoodchain.blockscout.com/tx/0xb4aaf1349d46225b2b0567d3f0869ce1acdb11f4ab8d2c7b2e55f52e57b7684d) | create VaultFactory |
| 4 | 86877041 | [`0xd85962b6a75031fefad90b49e1a8e95daa51fdc56d78fc34f137852fffb0cd56`](https://robinhoodchain.blockscout.com/tx/0xd85962b6a75031fefad90b49e1a8e95daa51fdc56d78fc34f137852fffb0cd56) | create ERC1967Proxy |
| 5 | 86877049 | [`0xee75dcf875504ee811d508f440b616d81872724162ae851b89e1d12ece0439e5`](https://robinhoodchain.blockscout.com/tx/0xee75dcf875504ee811d508f440b616d81872724162ae851b89e1d12ece0439e5) | create IndexRegistry |
| 6 | 86877057 | [`0xc47378fca4f652ee6a3401f9553e8afdad6310edffe6feb3cd95ee60ec63b931`](https://robinhoodchain.blockscout.com/tx/0xc47378fca4f652ee6a3401f9553e8afdad6310edffe6feb3cd95ee60ec63b931) | create ERC1967Proxy |
| 7 | 86877064 | [`0x99be75d1f631843f1ba9039af40836f18ca00f77d4075b7a4b9a96683003ba38`](https://robinhoodchain.blockscout.com/tx/0x99be75d1f631843f1ba9039af40836f18ca00f77d4075b7a4b9a96683003ba38) | setRegistry on the factory |
| 8 | 86877071 | [`0x4637834424cd905eb954cb1c50b8ea52c6c6dcf717423e27eead99d0ef5004b8`](https://robinhoodchain.blockscout.com/tx/0x4637834424cd905eb954cb1c50b8ea52c6c6dcf717423e27eead99d0ef5004b8) | setGuardian on the factory |
| 9 | 86877078 | [`0xc04055930dfacb8fbcb06a38cb9e6461f2a625b74c4b7af9e8047be43ea1dce8`](https://robinhoodchain.blockscout.com/tx/0xc04055930dfacb8fbcb06a38cb9e6461f2a625b74c4b7af9e8047be43ea1dce8) | setKeeper on the factory |
| 10 | 86877085 | [`0x00516909a266ec7aa657134f1ae310f0e6f9a263cb3778bd10a0742276da3127`](https://robinhoodchain.blockscout.com/tx/0x00516909a266ec7aa657134f1ae310f0e6f9a263cb3778bd10a0742276da3127) | setPriceDevBps on the factory |
| 11 | 86877092 | [`0xc4405f033d5434dcfb453b8b5bfcdaf3a03ac0c56adb57349051ba44da2d294c`](https://robinhoodchain.blockscout.com/tx/0xc4405f033d5434dcfb453b8b5bfcdaf3a03ac0c56adb57349051ba44da2d294c) | setSessionPriceAge on the factory |
| 12 | 86877099 | [`0x38cb2701311201804ce613a1167e55d63d10a498289872a374e8e33533a33dbe`](https://robinhoodchain.blockscout.com/tx/0x38cb2701311201804ce613a1167e55d63d10a498289872a374e8e33533a33dbe) | setAsset on the factory |
| 13 | 86877106 | [`0x5a4aa7f625ff167ad25a7211020fd6c583df873def98aa72bb4ba2d8529af195`](https://robinhoodchain.blockscout.com/tx/0x5a4aa7f625ff167ad25a7211020fd6c583df873def98aa72bb4ba2d8529af195) | setAsset on the factory |
| 14 | 86877113 | [`0x816a592b77c49e6b00bb601c86359f60e3f948883e81ea0945e5c225bcbaf85c`](https://robinhoodchain.blockscout.com/tx/0x816a592b77c49e6b00bb601c86359f60e3f948883e81ea0945e5c225bcbaf85c) | setAsset on the factory |
| 15 | 86877120 | [`0x616869c5b44bfbfad2fd7d2873a25e03f4c79ed58dc2b88e711fd732454b9d9d`](https://robinhoodchain.blockscout.com/tx/0x616869c5b44bfbfad2fd7d2873a25e03f4c79ed58dc2b88e711fd732454b9d9d) | setAsset on the factory |
| 16 | 86877127 | [`0x99fbf1860d3af19d2754fd1884f3845abd12e2aca571e56221a36a902de53e02`](https://robinhoodchain.blockscout.com/tx/0x99fbf1860d3af19d2754fd1884f3845abd12e2aca571e56221a36a902de53e02) | setAsset on the factory |
| 17 | 86877134 | [`0x71139281ac22b4a974501146ea78234dc5fec4db79762127c89d300197de9434`](https://robinhoodchain.blockscout.com/tx/0x71139281ac22b4a974501146ea78234dc5fec4db79762127c89d300197de9434) | setAsset on the factory |
| 18 | 86877142 | [`0x55a2e2dff2a2dfe02834a005955c2a867ef7836d8174203c5d93cd068daa252c`](https://robinhoodchain.blockscout.com/tx/0x55a2e2dff2a2dfe02834a005955c2a867ef7836d8174203c5d93cd068daa252c) | setAsset on the factory |
| 19 | 86877149 | [`0xaf8559b2ba74d5a69d76e870ff46cdffa220ea430eb430d4d94a20537d10352b`](https://robinhoodchain.blockscout.com/tx/0xaf8559b2ba74d5a69d76e870ff46cdffa220ea430eb430d4d94a20537d10352b) | setAsset on the factory |
| 20 | 86877156 | [`0xb166b6bb5e3159db01a467ee2bd8ff6033a520af7f80e704d201dfc912d1c651`](https://robinhoodchain.blockscout.com/tx/0xb166b6bb5e3159db01a467ee2bd8ff6033a520af7f80e704d201dfc912d1c651) | setAsset on the factory |
| 21 | 86877163 | [`0x3d0a4f94e0b9fc76985051f2f190dc4979d11687282ee642297d0c3d52e65815`](https://robinhoodchain.blockscout.com/tx/0x3d0a4f94e0b9fc76985051f2f190dc4979d11687282ee642297d0c3d52e65815) | setAsset on the factory |
| 22 | 86877170 | [`0x2e4921d7fa84a3720abe66c4772a516fff9687cbf6bbaada9e37cac2bad20066`](https://robinhoodchain.blockscout.com/tx/0x2e4921d7fa84a3720abe66c4772a516fff9687cbf6bbaada9e37cac2bad20066) | setCashToken on the factory |
| 23 | 86877176 | [`0xfbef85c5661a86d99e819955f3371057d196095100a24904fd5e9fabc43d3eb4`](https://robinhoodchain.blockscout.com/tx/0xfbef85c5661a86d99e819955f3371057d196095100a24904fd5e9fabc43d3eb4) | setRouter on the factory |
| 24 | 86877183 | [`0xd5dcf37634ef5e1f2bbbad3272e21b38a954f0c3a71de253e868e92e19fe4436`](https://robinhoodchain.blockscout.com/tx/0xd5dcf37634ef5e1f2bbbad3272e21b38a954f0c3a71de253e868e92e19fe4436) | setClosedDay on the factory |
| 25 | 86877190 | [`0xd51d5785d9b84e88a83db7d28a3e766bbfbc7fced83a0760d2b4b866dadddc3a`](https://robinhoodchain.blockscout.com/tx/0xd51d5785d9b84e88a83db7d28a3e766bbfbc7fced83a0760d2b4b866dadddc3a) | setClosedDay on the factory |
| 26 | 86877315 | [`0xf010148b00ff4fa03c7a97bf26cd89648c68cf7113235edbe9bf83ac97b2c4cb`](https://robinhoodchain.blockscout.com/tx/0xf010148b00ff4fa03c7a97bf26cd89648c68cf7113235edbe9bf83ac97b2c4cb) | setClosedDay on the factory |
| 27 | 86877326 | [`0x5b82784fd4c8ab858734b27812429e7e00628eceae69d4a9bb0fbb174c29825c`](https://robinhoodchain.blockscout.com/tx/0x5b82784fd4c8ab858734b27812429e7e00628eceae69d4a9bb0fbb174c29825c) | setClosedDay on the factory |
| 28 | 86877335 | [`0xfc73f71796961a9c65d485075ad759dc94d3fa4efcd3aa0d767760a5ca88d401`](https://robinhoodchain.blockscout.com/tx/0xfc73f71796961a9c65d485075ad759dc94d3fa4efcd3aa0d767760a5ca88d401) | setClosedDay on the factory |
| 29 | 86877342 | [`0x2b97304f619b8da3969e5ecfacecf62035ddc300bca3a4edd6d336aa224564d4`](https://robinhoodchain.blockscout.com/tx/0x2b97304f619b8da3969e5ecfacecf62035ddc300bca3a4edd6d336aa224564d4) | setClosedDay on the factory |
| 30 | 86877349 | [`0x74894b67491eca1b07d0cbb810e056a1429a6b3f8311db627346d6dd29da7205`](https://robinhoodchain.blockscout.com/tx/0x74894b67491eca1b07d0cbb810e056a1429a6b3f8311db627346d6dd29da7205) | setClosedDay on the factory |
| 31 | 86877356 | [`0x5719321c1a38f25a3bc53e48e8650bf55c082d84b79580706340197347a3c3d0`](https://robinhoodchain.blockscout.com/tx/0x5719321c1a38f25a3bc53e48e8650bf55c082d84b79580706340197347a3c3d0) | setClosedDay on the factory |
| 32 | 86877365 | [`0xe4695ad945bae9bb76c88b9e812a6eb8fbd70ffe705840cb1d935cd80a563105`](https://robinhoodchain.blockscout.com/tx/0xe4695ad945bae9bb76c88b9e812a6eb8fbd70ffe705840cb1d935cd80a563105) | setClosedDay on the factory |
| 33 | 86877376 | [`0x94a0db934f28813e2d585d992df48c683aa543cf1f07d050b7914acaade02056`](https://robinhoodchain.blockscout.com/tx/0x94a0db934f28813e2d585d992df48c683aa543cf1f07d050b7914acaade02056) | setClosedDay on the factory |
| 34 | 86877386 | [`0x9dc88c1259c5c4a70ff9800741d8d0313e27b502df55cf9326de899284ebf599`](https://robinhoodchain.blockscout.com/tx/0x9dc88c1259c5c4a70ff9800741d8d0313e27b502df55cf9326de899284ebf599) | setClosedDay on the factory |
| 35 | 86877396 | [`0x4ae9b0d9a4e1cfd755bd0e05d9f97580aef9ae2a0a13d291555e1d3ebe0bf931`](https://robinhoodchain.blockscout.com/tx/0x4ae9b0d9a4e1cfd755bd0e05d9f97580aef9ae2a0a13d291555e1d3ebe0bf931) | setClosedDay on the factory |
| 36 | 86877404 | [`0x4ac7f8f7b351e920db4a4d8e9b3bd679d8b14d8c7851ef987864b3ab9eb6bc15`](https://robinhoodchain.blockscout.com/tx/0x4ac7f8f7b351e920db4a4d8e9b3bd679d8b14d8c7851ef987864b3ab9eb6bc15) | create TimelockController |
| 37 | 86877411 | [`0xcdda1433865d59000a2155158593cd0602afff0b808e2ba9bd9e03659af02e5c`](https://robinhoodchain.blockscout.com/tx/0xcdda1433865d59000a2155158593cd0602afff0b808e2ba9bd9e03659af02e5c) | proposeAdmin on the factory |
| 38 | 86877418 | [`0x2aa9b55e00c59ca6703d60cf9033bc9288f50b6dfd9e204e46d9a31bf010a5ba`](https://robinhoodchain.blockscout.com/tx/0x2aa9b55e00c59ca6703d60cf9033bc9288f50b6dfd9e204e46d9a31bf010a5ba) | transferOwnership |
| 39 | 86877425 | [`0xee1d9032f2b9ba2a9628d95703d3dab3f7de195f47cf9659a4b6f948a15c8c8c`](https://robinhoodchain.blockscout.com/tx/0xee1d9032f2b9ba2a9628d95703d3dab3f7de195f47cf9659a4b6f948a15c8c8c) | scheduleBatch |
| 40 | 86877432 | [`0x66991fd571627570da04196985dc667ddc331ea940145386f66d6d581fe54ce0`](https://robinhoodchain.blockscout.com/tx/0x66991fd571627570da04196985dc667ddc331ea940145386f66d6d581fe54ce0) | executeBatch |
