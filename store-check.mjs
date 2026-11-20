#!/usr/bin/env node
// store-check.mjs: the store's checks for a whole site, run on your machine.
//
//   node store-check.mjs
//
// Run it from the top of your repository (where template.json is) before every submit. It checks
// the files your next commit holds (git's tracked files plus new files .gitignore does not hide),
// with the same rules submit uses, and prints one PASS or FAIL line per rule. It changes nothing.
// Exit code 0: every check passed. 1: something to fix.
//
// GENERATED for one template release (RULES.kit below). Every release brings its own copy: merge
// the release tag (DEVELOPERS.md, "How updates work") and this file is replaced with the new one.
// Needs Node 18 or later and nothing else (git for the files and the upstream releases).

import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

// The rules, generated from the store's own checks for this release. Do not edit: each release replaces this file.
const RULES = {
  "kit": {
    "template": "astro-app",
    "version": "0.10.24",
    "madeOn": "2026-11-16"
  },
  "versionsUrl": "https://ezystudio.com/api/public/templates/v1/versions",
  "templateFile": "template.json",
  "addOnManifest": "ZXp5c3R1ZGlvLWFwcC5qc29u",
  "managedCoreDir": "src/platform/",
  "seedFile": "prisma/seed.sql",
  "demoLogin": {
    "file": "prisma/demo-login.sql",
    "required": true,
    "exampleSha": "afbebdebe3abf7cc30b869c437d921051d04854d202cd938362fb967417baf06"
  },
  "managedCore": {
    "src/platform/api.ts": "5fe4d612d2d45f226afd32c49f1f57c8e252e6ec4eaeb3ad6f4ad81e0ef2500f",
    "src/platform/auth/admin.ts": "e3afe19731ab8c4d4d7cee430b0eeb2ae1fbe2fc98124c3080cd5b3fae9a6a09",
    "src/platform/auth/after-sign-in.ts": "47a2174798cf9009e8159a800961ee80d688bd942e54537306f7540ea1ce2f89",
    "src/platform/auth/audit.ts": "202130baba605935f23a859cb6e39ce5a6e360c387a926a86bba6c0d7ec8af29",
    "src/platform/auth/code-routes.ts": "d56829dbfb6d2408b546b17b3a47bc6582f937fa832b4524a35d59c674fe99ce",
    "src/platform/auth/codenames.ts": "908fccea749600f53920ad93f8ed1970461f8139ef0b844f7c8a57d8434057dc",
    "src/platform/auth/cookies.ts": "37418ae425740d521ccfa19c19ba89eb7bfe5061aac9efa4302127a4cba7b430",
    "src/platform/auth/email-check.ts": "21f268ded28f9306e1f606e3bb028f2a26663bf286b5ea2f12cd9015ccf9e3c2",
    "src/platform/auth/email.ts": "60554e089e5d314c645932a34760d822fb797bdfb54b8d3ddfdd59ebc9ec992f",
    "src/platform/auth/encoding.ts": "90fed25c78ab54f38b3704c6db165814c4b35c15807183f527a200e19813fb35",
    "src/platform/auth/end-access.ts": "f51dc93d6d96bed587fbd0d9bb56a2fe3d6b994ecc74c65a05d256e1343d334d",
    "src/platform/auth/index.ts": "8cdd9c9dab925a788255a985aa1c58419a5478d5cc5b471fe4e51a5be403e989",
    "src/platform/auth/input.ts": "72609de4e70849a91630e637aa2cb1f6401b5bf892ca4dd0b7ab3eafbbc00314",
    "src/platform/auth/jwt.ts": "4e133ec903424369aa23206f80cda3bb30452a5a0d322cac9b24d6ad26d62386",
    "src/platform/auth/keys.ts": "4363a680d9b7eeef2461698f828215a1985eb83476d0421a6cb2de7ea2fc9bdb",
    "src/platform/auth/kit.ts": "cfe1e16b14cf4e3c9fe12a8f47732d49d56821da74aee4472fa9dc175a0f2d91",
    "src/platform/auth/owner-seat.ts": "97da168c38b740f99c89bdf1f2a324ae803e52cfbdaaf22b71843af268e56691",
    "src/platform/auth/owner.ts": "8a4c97376e08de489170c3f39d938b73db9fd03e73fa596c874f95e3a5157b51",
    "src/platform/auth/password.ts": "9d3c5d97105460da73a0537773e74a006b5948e8db933b869db3daac8c0ecc23",
    "src/platform/auth/preview-cookies.ts": "dfb0661818411cfc7540382b8a5aae98f9bc661ba63528da4e68b67ee39b463f",
    "src/platform/auth/rate-limit.ts": "a1e188c72cf2f77a445f1686e242482c8aad62b5d90d238f8d596d7e29c9111d",
    "src/platform/auth/refresh.ts": "165f05e872b763a0e85be22d3ef52245fa9be472cbee66648dce5b13b8b1f987",
    "src/platform/auth/routes.ts": "fb7f0c054910b8fc22dcfe66d3ba22992a6fd15190248a3baa8d77b9ca3f3fc0",
    "src/platform/auth/security-routes.ts": "3d082167d0612a212b7eb128ebacf0c8872e3d1150501db50362aa82a200149b",
    "src/platform/auth/session.ts": "c27fb4ed0f5cefe6f6ff2f9f3aae11ccd4d28e8c8079e3b3f7a501a90bcdab8d",
    "src/platform/auth/settings.ts": "782a9a2c91cef6e7af0935241d48d153b08caee67ee7e275e2aff27ce5b57a82",
    "src/platform/auth/sign-up.ts": "cd040c2b1395848aa33c9fdbeb780925f89614d74128d9d941d25908fe6bc3f3",
    "src/platform/auth/store.ts": "7222c676150fce3b41c0d9f406552531849a0241ee0c3d05f53fb12ae5492391",
    "src/platform/auth/two-factor.ts": "617ddd9d23e22b658d16c74e6ab80c3f8a4ee2237dfb75966ed6ee5c9076cd64",
    "src/platform/background.ts": "01875c284203c87f444fbd9e92ab6cbe881a107c7bebfeb668cba81eb5cbddbb",
    "src/platform/browser.ts": "47d0c0887db9ec37cd7a599aab53eb1f0c1c2df936aa773000ceaea90959ff5e",
    "src/platform/cache-guard.ts": "13a6e08cca4569d38c9dae87891af00899e1d02176d87cf22ffca58c1eb2f4ce",
    "src/platform/cache.ts": "d9d60732067ef3a244818585230812187d706dd048c7fab7a95b5d9de90bf591",
    "src/platform/config.ts": "071684b6262af7f5403f0f0fa6ffe86a10a18fd15655f8ac5e6df04148922c06",
    "src/platform/db-socket-conversion.ts": "7425997c4ad9e736526bb03b736cbad8e22baafeb9fd833acc62bf8877c56e1f",
    "src/platform/db-socket.ts": "10022694ebbaa35ba3a0a7e93d2750c495f31f97fd4253f5cff1483365f63e41",
    "src/platform/db.ts": "a42e931634f011943a68696dd1715a90eef9685525534fa3466f3223de4c5208",
    "src/platform/DemoLogin.astro": "74f890eda0a51cbb426b723ec543cded65a5723245c04875c63764f2560885fe",
    "src/platform/files-browser.ts": "5ebd6a1f20d500b59efcf1f4fc268f0911823efedc68222f8484d2b59eaf1fad",
    "src/platform/files.ts": "45c9ca262dad2659418a5ed35a3c04ed2e8d411843981df1b4eba30c78aee25f",
    "src/platform/guards.ts": "dafd2c6be79e2b66ed9cdb7379444f41399cd4e303170a7cf06d11d066dc7b20",
    "src/platform/headers.ts": "ea01c0dbaf8b8e318c9a81ccd8f884c0875a579652e3a94a2e031db6f50546cb",
    "src/platform/idempotency.ts": "5c900d817bee2bbfeccda7b2ff7beb43d936ec92e50e7a0fb16a6a287e47f0ff",
    "src/platform/local-dev.ts": "f21f8865b927712c1618af844875c76343b4bfcf45248a6282a9d8a4d33efc05",
    "src/platform/payment-providers/access.ts": "bb9836a3d70808820131984eff870ad5e2a6478e8ad772d268bdfdae91e64af3",
    "src/platform/payment-providers/ezypay.ts": "4534568a9206fb86d4810da618530d80853056c0a04d292f2840cff44aa1cee8",
    "src/platform/payment-providers/http.ts": "8ae45cb856829b6592768883dd1ff2975b20bee2110bf6786664ade5e29087f7",
    "src/platform/payment-providers/index.ts": "1aef57ff11c71fadf20d7cf0daf068fc28d3adc3f2d70489ac7e863a0a280b03",
    "src/platform/payment-providers/keys.ts": "15191944467962b9116c15744cb7d29c78aaaf66ddea29bc0db92a0df240e529",
    "src/platform/payment-providers/money.ts": "4dc02d943ad6e062d2b40b03ea0eeea63382159ec5ddb60161f92d080ac2a9c0",
    "src/platform/payment-providers/paypal.ts": "68b4be5f485b06c993a6d17e336b722f4405656e6e8c8a8a89008f740fd24afe",
    "src/platform/payment-providers/signature.ts": "f8611c45f682b1fdc214fbb4be366c71800800c169b9d9a41896d6aeb6bd29ec",
    "src/platform/payment-providers/stripe.ts": "defa816ec62d013a2aa4b1b87d23afb77aeceae0a44ab405356ae6bd61718aa0",
    "src/platform/payment-providers/types.ts": "c517c1219a5e80f96c3bb6aba1b7160450debc35c03c14683527f68bdc52dc49",
    "src/platform/payment-providers/webhook-limit.ts": "411b9a701c99897a4ed2c48c9c111ccaa303c8951257ad368988480f2517f794",
    "src/platform/payments.ts": "3babc001ddaf59640646cbab2cd6d88bd81fb815a46dc26e5f950c7dc86d5841",
    "src/platform/permission-sync.ts": "293ad73e0760a13da3a536c6b632eea24da3286f9c0b4758632e37258c1b8f06",
    "src/platform/player/audio-player-engine.tsx": "c78c42793031bfe17c4562fd990624ed51db913b3b7bad643cdc741d0943873f",
    "src/platform/player/audio-player.tsx": "d22f9b824d1c3a3b2fb87c065a597ac9f697dfbfc1269c2d18939e19cb87c4e7",
    "src/platform/player/background-video-media.tsx": "daecb69ceaf8756763052280d60a7b7501ee954cae81b03454603b67637fb5a6",
    "src/platform/player/background-video.tsx": "c8aab3f158294410bd38ee4fe9fcd892b9a6bd824ab9a45417e90d0bce8b2743",
    "src/platform/player/chapters-panel.tsx": "12772d2333901c287bf03db59574df9bdb04f4cfc16416d003b7bec3e884cb00",
    "src/platform/player/chapters-track.ts": "4de0950c0789e0589baf3231ae63ec1d41e9dbd2e6fed3fbd98bcf0f2eff03df",
    "src/platform/player/interaction-layer.tsx": "24cf5106fbc0cb3708ad6953a1361aa813edbeab43d28008c59aa4804fc52a60",
    "src/platform/player/interactions.ts": "7a909c90ab7eba794e918651f9d2b9a8ce022be2d512fc399abdd6db85ced029",
    "src/platform/player/labels.ts": "e9af1224d9ba88a0c6a261c083bed6f0ebdee779a9b2f7b6ca9f1a6b77f63dd2",
    "src/platform/player/link-renewal.ts": "99e30ece6ffed56344e123130df8329dbad64e3f84cf88d0a6f8a9e57718933b",
    "src/platform/player/media-watch.tsx": "be7a38cb35e9278f76fce247a90667dd5bc5696ecfa4443c17b578576f8c69bc",
    "src/platform/player/player-classes.ts": "b101aa2c31673bb8615132e91ede45e7a904f1ebb913e57f96d7ceb8879a8a1e",
    "src/platform/player/player-config.ts": "2694bc835dbc96b72e58ebf5d0fefa1e24b0fc1d2af23cfc5b7955a12fb4974d",
    "src/platform/player/player-icons.tsx": "a0e9b9d08887091a94b0ffc315673ce6cac0dad062612135f6b31394233919c4",
    "src/platform/player/player-overlays.tsx": "acc0b61a3a9630a25d906bd3f3600e09aa0f7564bfa4df92500f3f090839dd77",
    "src/platform/player/player-ui.ts": "f243fc5756a03f62bd3f56f30292e5ddf3917dce3fe869c83323a233e3e65a1e",
    "src/platform/player/player.css": "ecd2adf6cbe46c79ff4e6cd41ffd3f5889688957a3d852192c1edf88b2e91442",
    "src/platform/player/seek-preview.ts": "0ecae69752dfc80bcd51d1d460cac97799fd2508c4205e6e95c35122d450523a",
    "src/platform/player/use-effect-event.ts": "8d9c1b5efffbd48d8a781b656de92ef4bc5153c180c44881c8e0d5995523eb89",
    "src/platform/player/video-player-engine.tsx": "e66697902ffabff2ac5053989db95aaa0972dedd0af6750bf13c4e70548dfa7f",
    "src/platform/player/video-player-skin.tsx": "ed47486201ba4f272e3609eb6cad0a4450046a791d39315ce0c1a1b64ad4410a",
    "src/platform/player/video-player.tsx": "30bd51f888a0007c09836c8aa3a358495fe7f6050138b8f65633de4b1b630bb9",
    "src/platform/player/watched-ranges.ts": "026d60884c3b440007797557743d5469f665efc0692b0004ecd66d27cab60200",
    "src/platform/player/wistia.ts": "3b0661adde7f33789d6eff3a915c08d1bab05454604dd244239d2515a69cf6d2",
    "src/platform/README.md": "b1a4ab5d7802034e6533a09fc72857ff98b38c11a012a81f4a581b45d7d2270f",
    "src/platform/request-scope.ts": "a9d4a8bcfdf253939c7a1a41283b080133e6b7974f2868d0ca04644f5c1e72ab",
    "src/platform/sanitize.ts": "5ec91612b8c3187171ee1e39424d6e91458d58ea19d413b0eca76212a924af4f",
    "src/platform/static-page.ts": "489c544220e1992b72b03cec8198b3b90c188d2671d616b262d1b1c571f649b5",
    "src/platform/types.ts": "8bb4f37febb760a29504819f6e2bdafdf89fe05c6ab463967b540912719c17e6",
    "src/platform/video-browser.ts": "89682e85b7d812fd43b4a77d65bc81af5c748d75b661bce739c7a6992027137a",
    "src/platform/video.ts": "e30c4285ec362e40ab5f94ebc36d1fada69100e22e7b89cf300bf51066fb81d7"
  },
  "agentInstructions": {
    "AGENTS.md": "29c9b7ff6277111006be98a510f69742502da9155237404361d0cac17bf1a278",
    "CLAUDE.md": "336cc4fbf19beaada7ccf9986414fa91851a8d7a07dfb3ccbe800a69eed0ab49",
    "docs/agent/auth.md": "16121c98bbdf702a79405ee52b3ba87037a76b4e4c924a815980003f34f9cd71",
    "docs/agent/background-jobs.md": "468bff990103671ea4189769a46e8fd05275a851a74bdc203d1f3b2e6f7dbfda",
    "docs/agent/cache.md": "4316d3edb70bdae4900dd537179582aa5839780878dd36d6da451af4fd501871",
    "docs/agent/database.md": "a78e91c82d2b79772e776839090a944215f844873bc66d54d37ee61305d02583",
    "docs/agent/files.md": "153f642a9a76b202bf3e0d8b3766678b098ccca4fd54fc81ba828b4ab5bafcf7",
    "docs/agent/orders-and-stock.md": "a0587b32dc8568889c8091215ed167649d730c989a1ee3ffc2c2ee6389e6b0b1",
    "docs/agent/payments-providers.md": "fd85b9d18f0d98a788b8a6e411433e92f57d290bafd4b42f4c97e63f1cb4264e",
    "docs/agent/payments.md": "888631bd0359b4961f12f26422c43c1a257cb5630d2d391230d20b8b47d9afbe",
    "docs/agent/performance.md": "eb331ba544cc60a097b0ce0ed5e90acf111489fac552acf36d7d2e041c12e318",
    "docs/agent/plans-catalogue.md": "338b30dd5103a46493e621deaffadb93f96279748f19c0cbd477a2fcaa7f6019",
    "docs/agent/publishing.md": "424f1529964881423a59473032014af994b24ee21ed7c9a2acfeb29eeb49c9f8",
    "docs/agent/review.md": "f82620e7f98525c19422b8e50b6e74481f835a17d34479fff82147977c9ee9dd",
    "docs/agent/roles-and-permissions.md": "2ea7f5ee98489eb6e97411679a27457a31ca51fce57add25a3d41f0b2f7a7208",
    "docs/agent/security.md": "007cb7dce5fa50cdd13bd7d1b5727743ce1e817c5ca36b7ef4ab5e3e389a239d",
    "docs/agent/seo.md": "ab4ca0d3658b2278a7f56ca8c6eb696d39e03ac28763de928c0373e181d7c4ae",
    "docs/agent/site-api.md": "75d3745e2d10bda8146a6d9ddb7893ab09be25a09b456aa5302a090459667bc4",
    "docs/agent/store-apps.md": "5c4cb24ff47abace24ba772fb57ddd924a28e33e83da0fdc3b6e741e2a5f18cd",
    "docs/agent/ui.md": "11defaec817347938ee890e5077fa76a1bc1ef16bb1bc5905f54be52dd86103e",
    "docs/agent/upgrade.md": "c4b0e5c025b2f9a90854af540f9a9fc9895deb3271ffa8704c6baf25007a48aa",
    "docs/agent/video.md": "ec0e2730eac7f2ba3683bf0528f245de5121367569f3a3a045d1e22934123c09",
    "GEMINI.md": "336cc4fbf19beaada7ccf9986414fa91851a8d7a07dfb3ccbe800a69eed0ab49"
  },
  "managedFiles": {
    "CHANGELOG.md": "6fa98fe31328f06990ac8f7b7fa952bb0186c11c03e6c984df3c3afeda27922d",
    "scripts/managed-files.json": "3667463482b96d8cd8cee82221de58b8b18594068a793b0a4a8705e7ec7d664d",
    "scripts/platform.mjs": "1ca6f149beb3d1a0f0d28cc2e1b7e50e469ad79d9792bd175823ab194aec08d6",
    "template.json": "08733748d3ee06cc726644f17b6087972dd1baf57552902f8dfd650fc53ababf"
  },
  "developerFiles": [
    "DEVELOPERS.md",
    "LICENSE",
    "STORE-LISTING.md",
    "store-check.mjs"
  ],
  "seed": {
    "required": true,
    "exampleSha": "40c0460209c965e695e41fa8265bcf49ca3740858f9bc3d0aa819f2ea29b7f8b"
  },
  "agentFiles": [
    "AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md"
  ],
  "agentDocsDir": "docs/agent/",
  "agentFileName": {
    "source": "^(agents?\\.md|claude(\\.local)?\\.md|gemini\\.md|codex\\.md|copilot-instructions\\.md|\\.cursorrules|\\.windsurfrules|\\.clinerules)$",
    "flags": "i"
  },
  "siteTemplates": [
    "astro-static",
    "astro-app"
  ],
  "allowedHidden": [
    ".gitignore",
    ".gitattributes",
    ".env.example",
    ".editorconfig",
    ".nvmrc",
    ".node-version",
    ".prettierrc",
    ".prettierrc.json",
    ".prettierignore"
  ],
  "deployConfig": {
    "source": "^(wrangler\\.(json|jsonc|toml)|Dockerfile|Makefile|vercel\\.json|netlify\\.toml)$",
    "flags": "i"
  },
  "nativeOrScript": {
    "source": "\\.(sh|bash|zsh|fish|ps1|bat|cmd|com|exe|dll|so|dylib|node|bin|jar|war|deb|rpm|msi|app|apk)$",
    "flags": "i"
  },
  "segment": {
    "source": "^[A-Za-z0-9_@()+[\\]=,.~-]+$",
    "flags": ""
  },
  "version": {
    "source": "^\\d+\\.\\d+\\.\\d+$",
    "flags": ""
  },
  "installScripts": [
    "preinstall",
    "install",
    "postinstall",
    "preprepare",
    "prepare",
    "postprepare",
    "prepublish",
    "dependencies"
  ],
  "nonPostgres": [
    "mysql",
    "mysql2",
    "mariadb",
    "@planetscale/database",
    "mongodb",
    "mongoose",
    "sqlite",
    "sqlite3",
    "better-sqlite3",
    "@libsql/client",
    "libsql",
    "redis",
    "ioredis",
    "@upstash/redis",
    "firebase",
    "firebase-admin",
    "@firebase/firestore",
    "@supabase/supabase-js",
    "faunadb",
    "fauna",
    "@aws-sdk/client-dynamodb",
    "@aws-sdk/lib-dynamodb",
    "dynamoose",
    "couchbase",
    "nano",
    "pouchdb",
    "cassandra-driver",
    "neo4j-driver",
    "@prisma/adapter-planetscale",
    "@prisma/adapter-libsql",
    "@prisma/adapter-d1"
  ],
  "secrets": [
    [
      "LS0tLS1CRUdJTiAoPzpSU0EgfEVDIHxEU0EgfE9QRU5TU0ggfFBHUCB8RU5DUllQVEVEICk/UFJJVkFURSBLRVkoPzogQkxPQ0spPy0tLS0t",
      "",
      "a private key"
    ],
    [
      "XGJBS0lBWzAtOUEtWl17MTZ9XGI=",
      "",
      "an AWS access key"
    ],
    [
      "XGIoPzpza3xyaylfbGl2ZV9bMC05QS1aYS16XXsxNix9XGI=",
      "",
      "a live Stripe key"
    ],
    [
      "XGJ3aHNlY19bMC05QS1aYS16XXsyNCx9XGI=",
      "",
      "a Stripe webhook secret"
    ],
    [
      "XGJnaFtwb3Vzcl1fW0EtWmEtejAtOV17MzYsfVxi",
      "",
      "a GitHub token"
    ],
    [
      "XGJnaXRodWJfcGF0X1tBLVphLXowLTlfXXs0MCx9XGI=",
      "",
      "a GitHub token"
    ],
    [
      "XGJ4b3hbYWJwcnNdLVtBLVphLXowLTktXXsxMCx9XGI=",
      "",
      "a Slack token"
    ],
    [
      "XGJBSXphWzAtOUEtWmEtel8tXXszNX1cYg==",
      "",
      "a Google API key"
    ],
    [
      "XGJzay0oPzphbnQtfHByb2otKT9bQS1aYS16MC05Xy1dezMyLH1cYg==",
      "",
      "an AI provider key"
    ],
    [
      "XGJTR1wuW0EtWmEtejAtOV8tXXsyMn1cLltBLVphLXowLTlfLV17NDN9XGI=",
      "",
      "a SendGrid key"
    ],
    [
      "XGJlenlbYS16XV9bQS1aYS16MC05XXsyNCx9XGI=",
      "",
      "an platform token"
    ]
  ],
  "credentials": {
    "files": {
      "source": "(?:\\.(?:[cm]?[jt]sx?|astro|vue|svelte|html?)|(?:^|\\/)package\\.json)$",
      "flags": "i"
    },
    "patterns": [
      {
        "rule": "credentials.ai_tools",
        "source": "(?:[~\\/\\\\]\\.claude(?=[\\/\\\\'\"\\x60]|$)|(?<![\\w.$-])\\.claude[\\/\\\\])",
        "flags": "gm",
        "what": "points at Claude Code's sign-in and settings (.claude)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(['\"\\x60])\\.claude\\1",
        "flags": "g",
        "what": "points at Claude Code's sign-in and settings (.claude)",
        "near": {
          "source": "\\b(?:join|resolve|homedir|HOME|USERPROFILE|readFile\\w*|readdir\\w*|existsSync|stat\\w*|createReadStream|opendir|glob|path|fs)\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(?<![\\w.$-])\\.claude\\.json\\b",
        "flags": "g",
        "what": "names Claude Code's settings file (.claude.json)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "\\.credentials\\.json\\b",
        "flags": "g",
        "what": "names Claude Code's sign-in file (.credentials.json)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(?:[~\\/\\\\]\\.codex(?=[\\/\\\\'\"\\x60]|$)|(?<![\\w.$-])\\.codex[\\/\\\\])",
        "flags": "gm",
        "what": "points at Codex's sign-in and settings (.codex)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(['\"\\x60])\\.codex\\1",
        "flags": "g",
        "what": "points at Codex's sign-in and settings (.codex)",
        "near": {
          "source": "\\b(?:join|resolve|homedir|HOME|USERPROFILE|readFile\\w*|readdir\\w*|existsSync|stat\\w*|createReadStream|opendir|glob|path|fs)\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.ai_tools",
        "source": "\\bcodex[/\\\\]auth\\.json\\b",
        "flags": "gi",
        "what": "names Codex's sign-in file (codex/auth.json)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "\\bauth\\.json\\b",
        "flags": "g",
        "what": "names an auth.json in the home or settings folder, where AI tools keep their sign-in",
        "near": {
          "source": "homedir|\\bHOME\\b|USERPROFILE|APPDATA|~[/\\\\]|\\/root\\/|\\/home\\/|\\/Users\\/|\\.config\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(?:[~\\/\\\\]\\.cursor(?=[\\/\\\\'\"\\x60]|$)|(?<![\\w.$-])\\.cursor[\\/\\\\])",
        "flags": "gm",
        "what": "points at Cursor's settings (.cursor)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(['\"\\x60])\\.cursor\\1",
        "flags": "g",
        "what": "points at Cursor's settings (.cursor)",
        "near": {
          "source": "\\b(?:join|resolve|homedir|HOME|USERPROFILE|readFile\\w*|readdir\\w*|existsSync|stat\\w*|createReadStream|opendir|glob|path|fs)\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.ai_tools",
        "source": "\\bgithub-copilot(?=[/\\\\'\"\\x60])",
        "flags": "g",
        "what": "points at GitHub Copilot's sign-in (github-copilot)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(?:[~\\/\\\\]\\.gemini(?=[\\/\\\\'\"\\x60]|$)|(?<![\\w.$-])\\.gemini[\\/\\\\])",
        "flags": "gm",
        "what": "points at Gemini's sign-in and settings (.gemini)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(['\"\\x60])\\.gemini\\1",
        "flags": "g",
        "what": "points at Gemini's sign-in and settings (.gemini)",
        "near": {
          "source": "\\b(?:join|resolve|homedir|HOME|USERPROFILE|readFile\\w*|readdir\\w*|existsSync|stat\\w*|createReadStream|opendir|glob|path|fs)\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(?<![\\w.$-])\\.aider\\.(?:conf|chat|input|tags|model)\\b",
        "flags": "g",
        "what": "points at Aider's settings (.aider)"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(?:[~\\/\\\\]\\.(?:codeium|windsurf|continue)(?=[\\/\\\\'\"\\x60]|$)|(?<![\\w.$-])\\.(?:codeium|windsurf|continue)[\\/\\\\])",
        "flags": "gm",
        "what": "points at an AI tool's settings folder"
      },
      {
        "rule": "credentials.ai_tools",
        "source": "(['\"\\x60])\\.(?:codeium|windsurf|continue)\\1",
        "flags": "g",
        "what": "points at an AI tool's settings folder",
        "near": {
          "source": "\\b(?:join|resolve|homedir|HOME|USERPROFILE|readFile\\w*|readdir\\w*|existsSync|stat\\w*|createReadStream|opendir|glob|path|fs)\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.ai_tools",
        "source": "\\.config[/\\\\](?:claude|anthropic|openai|codex|gemini)\\b",
        "flags": "gi",
        "what": "points at an AI tool's settings in ~/.config"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "(?:[~\\/\\\\]\\.ssh(?=[\\/\\\\'\"\\x60]|$)|(?<![\\w.$-])\\.ssh[\\/\\\\])",
        "flags": "gm",
        "what": "points at the SSH keys folder (.ssh)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "(['\"\\x60])\\.ssh\\1",
        "flags": "g",
        "what": "points at the SSH keys folder (.ssh)",
        "near": {
          "source": "\\b(?:join|resolve|homedir|HOME|USERPROFILE|readFile\\w*|readdir\\w*|existsSync|stat\\w*|createReadStream|opendir|glob|path|fs)\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\bid_(?:rsa|ed25519|ecdsa|dsa)\\b",
        "flags": "g",
        "what": "names an SSH private key (id_rsa, id_ed25519…)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "(?:[~\\/\\\\]\\.aws(?=[\\/\\\\'\"\\x60]|$)|(?<![\\w.$-])\\.aws[\\/\\\\])",
        "flags": "gm",
        "what": "points at the AWS keys folder (.aws)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "(['\"\\x60])\\.aws\\1",
        "flags": "g",
        "what": "points at the AWS keys folder (.aws)",
        "near": {
          "source": "\\b(?:join|resolve|homedir|HOME|USERPROFILE|readFile\\w*|readdir\\w*|existsSync|stat\\w*|createReadStream|opendir|glob|path|fs)\\b",
          "flags": ""
        }
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\.npmrc\\b",
        "flags": "g",
        "what": "names an .npmrc outside the repository, which holds npm publish tokens",
        "near": {
          "source": "homedir|\\bHOME\\b|USERPROFILE|APPDATA|~[/\\\\]|\\/root\\/|\\/home\\/|\\/Users\\/|\\.config\\b|\\.\\.[\\/\\\\]\\.npmrc",
          "flags": ""
        }
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\.config[/\\\\]gh(?=[/\\\\'\"\\x60]|$)",
        "flags": "gm",
        "what": "points at the GitHub CLI's sign-in (.config/gh)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\.git-credentials\\b",
        "flags": "g",
        "what": "names the saved git passwords file (.git-credentials)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "(?<![\\w.-])[._]netrc\\b",
        "flags": "g",
        "what": "names the saved logins file (.netrc)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\.docker[/\\\\]config\\.json\\b",
        "flags": "g",
        "what": "names Docker's sign-in file (.docker/config.json)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\.kube[/\\\\]config\\b",
        "flags": "g",
        "what": "names Kubernetes' sign-in file (.kube/config)"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\b(?:Login Data|Web Data|Local State|Cookies|cookies\\.sqlite|logins\\.json|key[34]\\.db)\\b",
        "flags": "g",
        "what": "names a browser's saved passwords or cookies",
        "near": {
          "source": "Chrome|Chromium|BraveSoftware|Brave|Firefox|Mozilla|Safari|Microsoft[/\\\\ ]Edge|Opera|Vivaldi|Library[/\\\\]|AppData|\\.config[/\\\\]|Profile|Default[/\\\\'\"\\x60]",
          "flags": ""
        }
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\.mozilla[/\\\\]firefox|Library[/\\\\]+(?:Application Support[/\\\\]+(?:Google[/\\\\]+Chrome|BraveSoftware|Firefox|Microsoft Edge)|Safari|Cookies|Keychains)|\\.config[/\\\\]+(?:google-chrome|chromium|BraveSoftware|microsoft-edge)|AppData[/\\\\]+(?:Local|Roaming)[/\\\\]+(?:Google|Mozilla|BraveSoftware|Microsoft[/\\\\]+Edge)",
        "flags": "g",
        "what": "points at a browser profile (saved passwords, cookies) or the keychain"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "\\bsecurity\\s+(?:find-generic-password|find-internet-password|dump-keychain)\\b|\\blogin\\.keychain|\\.keychain-db\\b",
        "flags": "g",
        "what": "reads the Mac keychain"
      },
      {
        "rule": "credentials.secrets_on_disk",
        "source": "(?<![.\\w])\\/etc\\/(?:passwd|shadow|sudoers|master\\.passwd)\\b",
        "flags": "g",
        "what": "reads the machine's user list or passwords (/etc/passwd)"
      },
      {
        "rule": "credentials.exfil_pattern",
        "source": "(?<![\\w$.])(?:eval|Function)\\s*\\(\\s*(?:atob|Buffer\\.from|unescape|decodeURIComponent|String\\.fromCharCode)\\b",
        "flags": "g",
        "what": "runs decoded text as code (eval or Function of a decoded string)"
      },
      {
        "rule": "credentials.exfil_pattern",
        "source": "String\\.fromCharCode\\s*\\(\\s*(?:0x[0-9a-f]+|\\d+)(?:\\s*[,+^-]\\s*(?:0x[0-9a-f]+|\\d+)){7,}",
        "flags": "gi",
        "what": "builds hidden text from character codes (String.fromCharCode chain)"
      },
      {
        "rule": "credentials.exfil_pattern",
        "source": "(?:\\\\x[0-9a-fA-F]{2}){16,}",
        "flags": "g",
        "what": "hides text as \\x escapes"
      }
    ]
  },
  "limits": {
    "entries": 6000,
    "files": 5000,
    "fileBytes": 10485760,
    "totalBytes": 52428800,
    "pathLength": 240
  }
};
// The demo login file's scanner: the store's own (apps/api demo_login_sql_policy.ts), printed here.
const demoLoginSqlProblems = function demoLoginSqlProblems(sql, max = 20) {
    const problems = [];
    const lineAt = (offset)=>{
        let line = 1;
        for(let k = 0; k < offset && k < sql.length; k++)if (sql[k] === '\n') line++;
        return line;
    };
    // Tokens: w = word (upper case), q = quoted name, s = string, p = punctuation.
    const tokens = [];
    const n = sql.length;
    let i = 0;
    const fail = (at, what)=>{
        problems.push({
            line: lineAt(at),
            what
        });
    };
    while(i < n){
        const c = sql[i];
        if (c === '-' && sql[i + 1] === '-') {
            while(i < n && sql[i] !== '\n')i++;
            continue;
        }
        if (c === '/' && sql[i + 1] === '*') {
            const start = i;
            let depth = 1;
            i += 2;
            while(i < n && depth > 0){
                if (sql[i] === '/' && sql[i + 1] === '*') {
                    depth++;
                    i += 2;
                } else if (sql[i] === '*' && sql[i + 1] === '/') {
                    depth--;
                    i += 2;
                } else i++;
            }
            if (depth > 0) {
                fail(start, "can't be read as SQL (a comment never ends)");
                return problems;
            }
            continue;
        }
        if (/\s/.test(c)) {
            i++;
            continue;
        }
        if (c === "'" || (c === 'E' || c === 'e') && sql[i + 1] === "'") {
            const start = i;
            const escapes = c !== "'";
            let k = escapes ? i + 2 : i + 1;
            let closed = false;
            while(k < n){
                if (escapes && sql[k] === '\\') {
                    k += 2;
                    continue;
                }
                if (sql[k] === "'") {
                    if (sql[k + 1] === "'") {
                        k += 2;
                        continue;
                    }
                    closed = true;
                    k++;
                    break;
                }
                k++;
            }
            if (!closed) {
                fail(start, "can't be read as SQL (a string never ends)");
                return problems;
            }
            tokens.push({
                k: 's',
                v: '',
                at: start
            });
            i = k;
            continue;
        }
        if (c === '"') {
            const start = i;
            let k = i + 1;
            let value = '';
            let closed = false;
            while(k < n){
                if (sql[k] === '"') {
                    if (sql[k + 1] === '"') {
                        value += '"';
                        k += 2;
                        continue;
                    }
                    closed = true;
                    k++;
                    break;
                }
                value += sql[k];
                k++;
            }
            if (!closed) {
                fail(start, "can't be read as SQL (a quoted name never ends)");
                return problems;
            }
            tokens.push({
                k: 'q',
                v: value.toUpperCase(),
                at: start
            });
            i = k;
            continue;
        }
        if (c === '$') {
            fail(i, 'uses dollar quoting or a parameter ($): write plain quoted text');
            return problems;
        }
        if (/[A-Za-z_\u0080-￿]/.test(c)) {
            const start = i;
            if ((c === 'U' || c === 'u') && sql[i + 1] === '&') {
                fail(start, 'spells a name or text with escape codes (U&)');
                return problems;
            }
            if (/[BbXxNn]/.test(c) && sql[i + 1] === "'") {
                i++;
                continue; // a B'…' / X'…' / N'…' string: the quote is read next
            }
            i++;
            while(i < n && /[A-Za-z0-9_$\u0080-￿]/.test(sql[i]))i++;
            tokens.push({
                k: 'w',
                v: sql.slice(start, i).toUpperCase(),
                at: start
            });
            continue;
        }
        if (/[0-9]/.test(c) || c === '.' && /[0-9]/.test(sql[i + 1] ?? '')) {
            i++;
            while(i < n && /[0-9.]/.test(sql[i]))i++;
            if (/[eE]/.test(sql[i] ?? '') && /[0-9+-]/.test(sql[i + 1] ?? '')) {
                i += 2;
                while(i < n && /[0-9]/.test(sql[i]))i++;
            }
            continue;
        }
        tokens.push({
            k: 'p',
            v: c,
            at: i
        });
        i++;
    }
    // Statements, split on `;`.
    const statements = [];
    let current = [];
    for (const t of tokens){
        if (t.k === 'p' && t.v === ';') {
            if (current.length) statements.push(current);
            current = [];
        } else current.push(t);
    }
    if (current.length) statements.push(current);
    const REFUSED_WORDS = {
        CREATE: 'creates something (CREATE)',
        ALTER: 'changes the schema (ALTER)',
        DROP: 'drops something (DROP)',
        TRUNCATE: 'empties a table (TRUNCATE)',
        DELETE: 'deletes rows (DELETE)',
        GRANT: 'grants database rights (GRANT)',
        REVOKE: 'takes away database rights (REVOKE)',
        COPY: 'reads or writes files (COPY)',
        EXECUTE: 'runs SQL built from text (EXECUTE)',
        CALL: 'calls a procedure (CALL)',
        WITH: 'uses WITH (write each statement on its own)',
        STANDARD_CONFORMING_STRINGS: 'changes how text is read',
        BACKSLASH_QUOTE: 'changes how text is read',
        INFORMATION_SCHEMA: 'reads the database catalogue'
    };
    const FUNCTIONS = new Set([
        'NOW',
        'LOWER',
        'UPPER',
        'TRIM',
        'COALESCE',
        'NULLIF',
        'CONCAT',
        'GEN_RANDOM_UUID',
        'CAST',
        'JSONB_BUILD_OBJECT',
        'JSON_BUILD_OBJECT',
        'JSONB_BUILD_ARRAY',
        'JSON_BUILD_ARRAY',
        'ARRAY',
        'ROW'
    ]);
    // Words that may come right before `(` without being a call.
    const BEFORE_PAREN = new Set([
        'VALUES',
        'IN',
        'ANY',
        'ALL',
        'EXISTS',
        'CONFLICT',
        'FROM',
        'JOIN',
        'SELECT',
        'WHERE',
        'AND',
        'OR',
        'NOT',
        'ON',
        'SET',
        'BY',
        'THEN',
        'ELSE',
        'WHEN',
        'CASE',
        'IS',
        'AS',
        'DISTINCT',
        'USING',
        'LATERAL'
    ]);
    for (const st of statements){
        if (problems.length >= max) break;
        const at = st[0].at;
        const first = st[0];
        const words = st.filter((t)=>t.k === 'w').map((t)=>t.v);
        const head = first.k === 'w' ? first.v : '';
        if (head === 'BEGIN' || head === 'COMMIT') {
            const rest = words.slice(1).filter((w)=>w !== 'TRANSACTION' && w !== 'WORK');
            if (rest.length || st.some((t)=>t.k !== 'w')) fail(at, `has a ${head} with more after it`);
            continue;
        }
        if (head !== 'INSERT' && head !== 'UPDATE') {
            fail(at, `starts with ${head || 'something'}: only INSERT … ON CONFLICT and UPDATE are allowed`);
            continue;
        }
        let what = null;
        for (const w of words){
            if (REFUSED_WORDS[w]) {
                what = REFUSED_WORDS[w];
                break;
            }
            if (/^PG_/.test(w) || w === '_PRISMA_MIGRATIONS') {
                what = `uses ${w.toLowerCase()}, a system table or function`;
                break;
            }
        }
        if (!what) {
            for (const t of st){
                if (t.k === 'q' && (/^PG_/.test(t.v) || t.v === '_PRISMA_MIGRATIONS' || t.v === 'INFORMATION_SCHEMA')) {
                    what = `uses ${t.v.toLowerCase()}, a system table or function`;
                    break;
                }
            }
        }
        if (!what && head === 'INSERT') {
            if (words[1] !== 'INTO') what = 'is an INSERT without INTO';
            else if (!/\bON CONFLICT\b/.test(words.join(' '))) what = 'is an INSERT without ON CONFLICT (it must be safe to run twice)';
        }
        if (!what) {
            // The target table: plain, never schema-qualified.
            const target = head === 'INSERT' ? 2 : 1;
            let k = target;
            if (head === 'UPDATE' && st[k]?.k === 'w' && st[k].v === 'ONLY') k++;
            const table = st[k];
            if (!table || table.k !== 'w' && table.k !== 'q') what = 'names no table';
            else if (st[k + 1]?.k === 'p' && st[k + 1].v === '.') what = "names a table in another schema: use this app's own tables";
        }
        if (!what) {
            // Every `(` after a word or a quoted name: a keyword, a table / alias column list, or an allowed function.
            for(let k = 1; k < st.length && !what; k++){
                const t = st[k];
                if (t.k !== 'p' || t.v !== '(') continue;
                const before = st[k - 1];
                const twoBefore = st[k - 2];
                if (before.k === 'p' || before.k === 's') continue;
                const listAfter = twoBefore && twoBefore.k === 'w' && (twoBefore.v === 'INTO' || twoBefore.v === 'AS');
                if (listAfter) continue;
                if (before.k === 'w' && (BEFORE_PAREN.has(before.v) || FUNCTIONS.has(before.v))) continue;
                what = `calls ${before.v.toLowerCase() || 'a function'}(): only now(), lower(), coalesce() and other plain functions are allowed`;
            }
        }
        if (!what && head === 'INSERT') {
            // `INSERT INTO t (…) SELECT … INTO x`: SELECT INTO makes a table.
            const intos = words.filter((w)=>w === 'INTO').length;
            if (intos > 1) what = 'uses SELECT … INTO (it makes a table)';
        }
        if (what) fail(at, what);
    }
    return problems.slice(0, max);
};

const re = rule => new RegExp(rule.source, rule.flags);
const DEPLOY_CONFIG = re(RULES.deployConfig);
const NATIVE_OR_SCRIPT = re(RULES.nativeOrScript);
const SEGMENT = re(RULES.segment);
const VERSION = re(RULES.version);
const SECRETS = RULES.secrets.map(([source, flags, what]) => [new RegExp(Buffer.from(source, 'base64').toString('utf8'), flags), what]);
const ALLOWED_HIDDEN = new Set(RULES.allowedHidden);
const CREDENTIAL_FILES = re(RULES.credentials.files);
const CREDENTIALS = RULES.credentials.patterns.map(p => ({what: p.what, re: new RegExp(p.source, p.flags.replace('g', '')), near: p.near ? re(p.near) : null}));
const AGENT_FILE_NAME = re(RULES.agentFileName);
const isInstruction = path => RULES.agentFiles.includes(path) || path.startsWith(RULES.agentDocsDir);
const NON_POSTGRES = new Set(RULES.nonPostgres);
const SHOWN = 10;
const MB = 1024 * 1024;

const root = process.cwd();
const sha = content => createHash('sha256').update(content).digest('hex');
/** A file that differs only by Windows line endings: say how to fix that. */
const crlfOnly = (content, expected) =>
  content.includes(13) && sha(Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'))) === expected;
const contents = new Map();
const results = [];
const pass = (title, note) => results.push({ok: true, title, note});
const fail = (title, note, paths = []) => results.push({ok: false, title, note, paths});
const warn = (title, note, paths = []) => results.push({ok: true, warn: true, title, note, paths});

// ── which files: what the next commit holds ─────────────────────────────────

/** A .gitignore file as rules (the usual subset: comments, !, trailing /, leading /, *, **, ?, [..]). */
function ignoreRules(text, base) {
  const rules = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) {
      negate = true;
      line = line.slice(1);
    } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    const anchored = line.includes('/');
    line = line.replace(/^\/+/, '');
    if (!line) continue;
    rules.push({negate, dirOnly, anchored, base, regex: globToRegex(line)});
  }
  return rules;
}

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        out += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end === -1) out += '\\[';
      else {
        out += '[' + glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end;
      }
    } else if (c === '\\' && i + 1 < glob.length) {
      out += glob[i + 1].replace(/[.*+?^()|[\]{}\\/-]/g, '\\$&');
      i += 1;
    } else out += c.replace(/[.*+?^()|[\]{}\\/-]/g, '\\$&');
  }
  return new RegExp('^' + out + '$');
}

function ignored(rules, rel, isDir) {
  let result = false;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.base && !rel.startsWith(rule.base + '/')) continue;
    const local = rule.base ? rel.slice(rule.base.length + 1) : rel;
    const subject = rule.anchored ? local : local.slice(local.lastIndexOf('/') + 1);
    if (rule.regex.test(subject)) result = !rule.negate;
  }
  return result;
}

/** Every file under the root that .gitignore (at any level) does not hide. */
function walk() {
  const out = [];
  const visit = (dir, rel, inherited) => {
    let rules = inherited;
    const gi = join(dir, '.gitignore');
    if (existsSync(gi)) rules = inherited.concat(ignoreRules(readFileSync(gi, 'utf8'), rel));
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === '.git') continue;
      const path = rel ? rel + '/' + entry.name : entry.name;
      const isDir = entry.isDirectory();
      if (ignored(rules, path, isDir)) continue;
      if (isDir) visit(join(dir, entry.name), path, rules);
      else out.push(path);
    }
  };
  visit(root, '', []);
  return out;
}

function gitFiles() {
  const git = args =>
    execFileSync('git', args, {cwd: root, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * MB});
  let prefix;
  try {
    prefix = git(['rev-parse', '--show-prefix']).toString('utf8').trim();
  } catch {
    return null;
  }
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return {prefix, files: [...new Set(listed)]};
}

// ── the checks (app_installs/site_bundle.ts, in its order) ──────────────────

function listed(paths) {
  const shown = paths.slice(0, SHOWN);
  if (paths.length > SHOWN) shown.push('… and ' + (paths.length - SHOWN) + ' more');
  return shown;
}

function readJson(path) {
  try {
    const value = JSON.parse(readFileSync(join(root, path), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** Why one path is refused, as submit says it, or null. */
function pathProblem(path) {
  if (path.length > RULES.limits.pathLength) return ['bad_path', 'longer than ' + RULES.limits.pathLength + ' characters'];
  if (path.includes('\\') || path.startsWith('/') || path.includes('\0')) return ['bad_path', 'not a plain relative path'];
  const segments = path.split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === '' || segment === '.' || segment === '..') return ['bad_path', 'not a plain relative path'];
    const last = i === segments.length - 1;
    if (segment.startsWith('.') && !(last && ALLOWED_HIDDEN.has(segment))) return ['hidden', ''];
    if (!SEGMENT.test(segment)) return ['bad_path', 'has characters a path may not use'];
  }
  const base = segments[segments.length - 1];
  if (DEPLOY_CONFIG.test(base)) return ['deploy', ''];
  if (NATIVE_OR_SCRIPT.test(base)) return ['native', ''];
  return null;
}

function run() {
  const kit = RULES.kit;
  console.log('Store check: ' + kit.template + ' template release ' + kit.version + ' (made on ' + kit.madeOn + ')');

  if (!existsSync(join(root, RULES.templateFile))) {
    fail(RULES.templateFile, 'There is no ' + RULES.templateFile + ' here. Run node store-check.mjs from the top of your repository.');
    return;
  }

  // Files.
  let files;
  let source;
  const fromGit = gitFiles();
  if (fromGit && fromGit.prefix) {
    fail('Repository top', 'This folder is ' + fromGit.prefix + ' inside its git repository. The store reads the repository from its top: ' + RULES.templateFile + ' must be there.');
    files = fromGit.files.filter(p => existsOrLink(p));
    source = 'git';
  } else if (fromGit) {
    files = fromGit.files.filter(p => existsOrLink(p));
    source = 'git';
  } else {
    files = walk();
    source = 'walk';
  }
  console.log(
    source === 'git'
      ? 'Checking ' + files.length + ' files: the ones git tracks and new ones .gitignore does not hide.'
      : 'Not a git repository yet: checking all ' + files.length + ' files .gitignore does not hide.'
  );
  if (source === 'git' && fromGit.prefix) return;

  // template.json
  const tpl = readJson(RULES.templateFile);
  if (!tpl) fail(RULES.templateFile, RULES.templateFile + ' is not valid JSON.');
  else if (!RULES.siteTemplates.includes(tpl.template))
    fail(RULES.templateFile, '"template" must be ' + RULES.siteTemplates.map(t => '"' + t + '"').join(' or ') + '.');
  else if (typeof tpl.version !== 'string' || !VERSION.test(tpl.version))
    fail(RULES.templateFile, '"version" must be the template\'s version, like "' + kit.version + '".');
  else if (tpl.template !== kit.template)
    fail(RULES.templateFile, 'This site is on the ' + tpl.template + ' template; this store-check.mjs is for ' + kit.template + '. Put back the template\'s template.json: git checkout v' + kit.version + ' -- template.json');
  else if (tpl.version !== kit.version)
    fail(
      RULES.templateFile,
      'template.json says ' + tpl.version + ', but this store-check.mjs came with release ' + kit.version + '. A merge was left half done: finish it (git merge v' + kit.version + '), or put back the template\'s copy: git checkout v' + kit.version + ' -- template.json store-check.mjs'
    );
  else pass(RULES.templateFile, tpl.template + ' ' + tpl.version + ', the release this store-check.mjs came with');

  const ADD_ON_MANIFEST = Buffer.from(RULES.addOnManifest, 'base64').toString('utf8');
  if (files.includes(ADD_ON_MANIFEST) || existsSync(join(root, ADD_ON_MANIFEST)))
    fail(ADD_ON_MANIFEST, ADD_ON_MANIFEST + ' is for add-ons. A whole site has only ' + RULES.templateFile + ': remove ' + ADD_ON_MANIFEST + '.');

  // package.json
  const pkg = files.includes('package.json') ? readJson('package.json') : null;
  if (!files.includes('package.json')) fail('package.json', 'The site has no package.json at its top level.');
  else if (!pkg) fail('package.json', 'package.json is not valid JSON.');
  else {
    const scripts = pkg.scripts ?? {};
    const runsOnInstall = RULES.installScripts.find(name => scripts && typeof scripts === 'object' && name in scripts);
    if (typeof scripts !== 'object' || Array.isArray(scripts)) fail('package.json', '"scripts" in package.json must be an object.');
    else if (typeof scripts.build !== 'string') fail('package.json', 'package.json needs a "build" script.');
    else if (runsOnInstall)
      fail('package.json', 'package.json has a "' + runsOnInstall + '" script, which npm runs on install in every customer\'s editor. Remove it.');
    else pass('package.json', 'a build script and no install scripts (' + RULES.installScripts.join(', ') + ')');

    const otherDb = [];
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const deps = pkg[field];
      if (deps && typeof deps === 'object') for (const name of Object.keys(deps)) if (NON_POSTGRES.has(name)) otherDb.push(name + ' (' + field + ')');
    }
    if (otherDb.length)
      fail('Postgres only', 'These connect to a database other than Postgres. A store site keeps its data in its own Postgres database only.', otherDb);
    else pass('Postgres only', 'no package for another database');
  }

  // Paths.
  const byKind = {bad_path: [], hidden: [], deploy: [], native: []};
  for (const path of files) {
    const problem = pathProblem(path);
    if (problem) byKind[problem[0]].push(problem[1] ? path + ': ' + problem[1] : path);
  }
  if (byKind.hidden.length)
    fail('Hidden files', 'Only ' + RULES.allowedHidden.join(', ') + ' may be in a store site. Delete these from the repository (git rm -r --cached <path>) and keep them out with .gitignore.', listed(byKind.hidden));
  else pass('Hidden files', 'only ' + RULES.allowedHidden.join(', '));
  if (byKind.bad_path.length) fail('Paths', 'Plain relative paths only: letters, digits and _ @ ( ) + [ ] = , . ~ -.', listed(byKind.bad_path));
  else pass('Paths', 'every path is plain');
  if (byKind.deploy.length) fail('Deploy config', 'The platform deploys every site itself: remove these.', listed(byKind.deploy));
  else pass('Deploy config', 'none');
  if (byKind.native.length) fail('Shell scripts and native programs', 'Write scripts in JavaScript (scripts/*.mjs) instead.', listed(byKind.native));
  else pass('Shell scripts and native programs', 'none');

  // Links, sizes, secrets: read every file once.
  const links = [];
  const tooBig = [];
  const secrets = [];
  const credentials = [];
  const hashes = new Map();
  const instructionHashes = new Map();
  let total = 0;
  const dirs = new Set();
  for (const path of files) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
    const full = join(root, path);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      links.push(path);
      continue;
    }
    if (!info.isFile()) continue;
    total += info.size;
    if (info.size > RULES.limits.fileBytes) {
      tooBig.push(path + ' (' + (info.size / MB).toFixed(1) + ' MB)');
      continue;
    }
    const content = readFileSync(full);
    if (path.startsWith(RULES.managedCoreDir)) hashes.set(path, sha(content));
    if (isInstruction(path)) instructionHashes.set(path, sha(content));
    if ((RULES.managedFiles && path in RULES.managedFiles) || path === RULES.seedFile || path === RULES.demoLogin.file) contents.set(path, content);
    if (path.startsWith(RULES.managedCoreDir) || isInstruction(path)) contents.set(path, content);
    if (!content.subarray(0, 8000).includes(0)) {
      const text = content.toString('utf8');
      const hit = SECRETS.find(([pattern]) => pattern.test(text));
      if (hit) secrets.push(path + ': looks like ' + hit[1]);
      if (!path.startsWith(RULES.managedCoreDir) && !RULES.developerFiles.includes(path) && CREDENTIAL_FILES.test(path)) {
        const lines = text.split('\n');
        for (let n = 0; n < lines.length; n++) {
          const line = lines[n];
          if (/^\s*(\/\/|\/\*|\*)/.test(line)) continue;
          const found = CREDENTIALS.find(p => p.re.test(line) && (!p.near || p.near.test(line)));
          if (found) credentials.push(path + ':' + (n + 1) + ': ' + found.what);
        }
      }
    }
  }
  if (links.length) fail('Symbolic links', 'A store site may not hold symbolic links: put the real file there.', listed(links));
  else pass('Symbolic links', 'none');

  // Every managed file: byte for byte this release's (submit: platform_changed,
  // instructions_changed, managed_file_changed). The fix is the same git command for all.
  const restore = [];
  const state = (path, got, expected) => {
    if (!got) {
      restore.push(path);
      return path + ': missing';
    }
    restore.push(path);
    return path + (crlfOnly(contents.get(path) || Buffer.alloc(0), expected) ? ': Windows line endings (CRLF); the template\'s are LF' : ': changed');
  };
  if (RULES.managedCore) {
    const core = new Map(Object.entries(RULES.managedCore));
    const changed = [];
    for (const [path, expected] of core) {
      const got = hashes.get(path);
      if (got !== expected) changed.push(state(path, got, expected));
    }
    for (const path of hashes.keys()) if (!core.has(path)) changed.push(path + ': added (git rm it; your code goes in src/server/ or src/lib/)');
    if (changed.length)
      fail(RULES.managedCoreDir + ' (platform_changed)', 'The template\'s managed core must be exactly release ' + kit.version + '\'s. Your code goes in src/server/ or src/lib/.', listed(changed));
    else pass(RULES.managedCoreDir, 'the template\'s managed core, untouched (' + core.size + ' files)');
  }
  if (RULES.managedFiles) {
    const changed = [];
    for (const [path, expected] of Object.entries(RULES.managedFiles)) {
      const content = contents.get(path);
      const got = content ? sha(content) : null;
      if (got !== expected) changed.push(state(path, got, expected));
    }
    const names = Object.keys(RULES.managedFiles).join(', ');
    if (changed.length) fail('The template\'s own files (managed_file_changed)', names + ' must be exactly release ' + kit.version + '\'s.', listed(changed));
    else pass('The template\'s own files', names + ', untouched');
  }

  // AGENTS.md, CLAUDE.md, GEMINI.md and docs/agent/: byte for byte the template's, and no other
  // instructions for the owner's AI anywhere.
  const instructions = [];
  if (RULES.agentInstructions) {
    const expected = new Map(Object.entries(RULES.agentInstructions));
    for (const [path, want] of expected) {
      const got = instructionHashes.get(path);
      if (got !== want) instructions.push(state(path, got, want));
    }
    for (const path of instructionHashes.keys()) if (!expected.has(path)) instructions.push(path + ': added');
  }
  for (const path of files) {
    const base = path.slice(path.lastIndexOf('/') + 1);
    if (!isInstruction(path) && AGENT_FILE_NAME.test(base)) instructions.push(path + ': instructions for the AI outside the template\'s');
  }
  if (instructions.length)
    fail('Instructions for the AI (instructions_changed)', 'Keep ' + RULES.agentFiles.join(', ') + ' and ' + RULES.agentDocsDir + ' exactly as release ' + kit.version + ' has them, and add no others; describe your app in README.md.', listed(instructions));
  else pass('Instructions for the AI', RULES.agentFiles.join(', ') + ' and ' + RULES.agentDocsDir + ' as the template has them');
  if (restore.length) {
    const crlf = results.some(r => !r.ok && (r.paths || []).some(p => p.includes('CRLF')));
    warn(
      'Put the template\'s files back',
      'git checkout v' + kit.version + ' -- ' + restore.slice(0, 20).join(' ') + (restore.length > 20 ? ' …' : '') + ', then commit.' +
        (crlf ? ' For Windows line endings: git add --renormalize . (the template\'s .gitattributes keeps them LF), then commit.' : '')
    );
  }

  // Sample data (web apps): required, and it adds rows (submit: seed_missing, seed_empty).
  if (RULES.seed.required) {
    const seed = contents.get(RULES.seedFile);
    const text = seed ? seed.toString('utf8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim() : '';
    if (!text)
      fail(RULES.seedFile + ' (seed_missing)', 'Add ' + RULES.seedFile + ' with sample data so the store preview shows a working app; see DEVELOPERS.md › Sample data.');
    else if (!/\binsert\s+into\b/i.test(text))
      fail(RULES.seedFile + ' (seed_empty)', RULES.seedFile + ' adds no rows. Give it at least one INSERT of sample data so the store preview shows a working app; see DEVELOPERS.md › Sample data.');
    else if (RULES.seed.exampleSha && sha(seed) === RULES.seed.exampleSha)
      warn(RULES.seedFile, 'still the template\'s example (its job board\'s sample jobs). Replace it with sample data for your app: it loads into review and your public preview, and fails there if your schema has no "jobs" table.');
    else pass(RULES.seedFile, 'your sample data. The review checks what it may do; load it twice on your machine (npm run db:seed) to be sure it is safe to run twice.');
  }

  // The read-only demo admin (web apps): required and data only (submit: demo_login_missing, demo_login_unsafe).
  if (RULES.demoLogin.required) {
    const file = contents.get(RULES.demoLogin.file);
    const sql = file ? file.toString('utf8') : '';
    const problems = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').trim() ? demoLoginSqlProblems(sql, 5) : null;
    if (!problems)
      fail(RULES.demoLogin.file + ' (demo_login_missing)', 'Add the read-only demo admin for the store\'s previews: npm run platform -- demo-login --email <email> --password <password> (docs/agent/store-apps.md).');
    else if (problems.length)
      fail(RULES.demoLogin.file + ' (demo_login_unsafe)', 'It may only INSERT … ON CONFLICT and UPDATE your app\'s own tables (docs/agent/store-apps.md).', problems.map(p => 'line ' + p.line + ' ' + p.what));
    else if (RULES.demoLogin.exampleSha && sha(file) === RULES.demoLogin.exampleSha)
      warn(RULES.demoLogin.file, 'still the template\'s example (demo@example.com). Make your own: npm run platform -- demo-login --email <email> --password <password>, and give the same on the submission form.');
    else pass(RULES.demoLogin.file, 'data only. Give the same email and password on the submission form, and keep <DemoLogin /> on your sign-in page.');
  }

  if (credentials.length)
    fail('Sign-ins and keys', 'This code reads AI tools\' sign-ins or keys and passwords on the computer that runs it (it runs in the customer\'s editor, next to their AI sign-in). The store refuses it: remove it.', listed(credentials));
  else pass('Sign-ins and keys', 'nothing reads AI tools\' sign-ins or other keys on the computer');

  if (secrets.length) fail('Secrets', 'Remove these and keep keys in the site\'s settings, never in the code.', listed(secrets));
  else pass('Secrets', 'nothing that looks like a live key or token');

  const sizes = [];
  if (files.length > RULES.limits.files) sizes.push(files.length + ' files: at most ' + RULES.limits.files);
  if (files.length + dirs.size + 1 > RULES.limits.entries) sizes.push(files.length + dirs.size + 1 + ' files and folders: at most ' + RULES.limits.entries);
  if (total > RULES.limits.totalBytes) sizes.push((total / MB).toFixed(1) + ' MB in all: at most ' + RULES.limits.totalBytes / MB + ' MB');
  for (const big of tooBig) sizes.push(big + ': at most ' + RULES.limits.fileBytes / MB + ' MB per file');
  if (sizes.length) fail('Size', 'Make the site smaller: big pictures and videos belong in file storage, not the repository.', listed(sizes));
  else pass('Size', files.length + ' files, ' + (total / MB).toFixed(1) + ' MB (limits: ' + RULES.limits.files + ' files, ' + RULES.limits.totalBytes / MB + ' MB, ' + RULES.limits.fileBytes / MB + ' MB per file)');

}

function existsOrLink(path) {
  try {
    lstatSync(join(root, path));
    return true;
  } catch {
    return false;
  }
}

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

/**
 * Known security problems in the packages, as the store's review finds them: npm audit over the
 * lockfile. High or critical fails; moderate and low are listed as notes. Offline is a note, never a
 * failure: the store runs the same audit on every submit.
 */
function audit() {
  const title = 'Known security problems (npm audit)';
  if (!existsSync(join(root, 'package-lock.json'))) {
    fail(title, 'package-lock.json is missing. Run npm install, commit package-lock.json, then run this again.');
    return;
  }
  let out = '';
  try {
    out = execFileSync('npm', ['audit', '--json', '--package-lock-only'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * MB,
    });
  } catch (error) {
    // npm audit exits non-zero when it finds something: its report is still on stdout.
    out = error && error.stdout ? String(error.stdout) : '';
  }
  let data = null;
  try {
    data = JSON.parse(out);
  } catch {
    data = null;
  }
  if (!data || data.error) {
    warn(title, 'npm audit could not run here (offline, or npm is missing). The store runs it when you submit: run this again online.');
    return;
  }
  const found = Object.values(data.vulnerabilities || {});
  if (!found.length) {
    pass(title, 'none in your packages.');
    return;
  }
  const rank = {critical: 4, high: 3, moderate: 2, low: 1, info: 0};
  const lines = (list) =>
    list
      .sort((a, b) => (rank[b.severity] || 0) - (rank[a.severity] || 0))
      .map((v) => {
        const advisories = (v.via || []).filter((x) => x && typeof x === 'object');
        const what = advisories.length
          ? Array.from(new Set(advisories.map((a) => a.title + (a.url ? ' (' + a.url + ')' : '')))).join('; ')
          : 'through ' + (v.via || []).join(', ');
        const fix = v.fixAvailable === true
          ? 'fix: npm audit fix'
          : v.fixAvailable && v.fixAvailable.name
            ? 'fix: update ' + v.fixAvailable.name + ' to ' + v.fixAvailable.version + (v.fixAvailable.isSemVerMajor ? ' (a major version: check your code)' : '')
            : 'no fix published yet: replace or remove ' + v.name;
        return v.severity.toUpperCase() + '  ' + v.name + (v.isDirect ? '' : ' (comes in through another package)') + ': ' + what + '. ' + fix;
      });
  const serious = found.filter((v) => v.severity === 'critical' || v.severity === 'high');
  const minor = found.filter((v) => !(v.severity === 'critical' || v.severity === 'high'));
  if (serious.length) {
    fail(title, serious.length + ' high or critical. Fix these before you submit: the review lists them for staff.', lines(serious));
  } else {
    pass(title, 'no high or critical problem.');
  }
  if (minor.length) warn('Smaller security notes (npm audit)', minor.length + ' moderate or low. Fix them when you can.', lines(minor));
}

/**
 * Is this the template's CURRENT release? Submit refuses any other one. The platform's public answer
 * first, then the upstream remote's tags; neither reachable is a note, never a failure.
 */
async function currentRelease() {
  const title = 'Current template release';
  const tpl = readJson(RULES.templateFile);
  if (!tpl || typeof tpl.version !== 'string' || !VERSION.test(tpl.version)) return;
  let newest = null;
  let from = '';
  if (RULES.versionsUrl) {
    try {
      const res = await fetch(RULES.versionsUrl, {signal: AbortSignal.timeout(5000), headers: {accept: 'application/json'}});
      const body = res.ok ? await res.json() : null;
      const v = body && body[RULES.kit.template];
      if (typeof v === 'string' && VERSION.test(v)) {
        newest = v;
        from = 'the platform';
      }
    } catch {
      // offline: try the upstream tags
    }
  }
  if (!newest) {
    try {
      const out = execFileSync('git', ['ls-remote', '--tags', '--refs', 'upstream'], {cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000});
      for (const line of out.split('\n')) {
        const m = /refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(line.trim());
        if (m && (!newest || compareVersions(m[1], newest) > 0)) newest = m[1];
      }
      if (newest) from = 'the upstream remote\'s tags';
    } catch {
      // no upstream remote, or offline
    }
  }
  if (!newest) {
    warn(title, 'Couldn\'t find the newest release (offline, or no "upstream" remote: git remote -v). Submit checks it: run this again online.');
    return;
  }
  const order = compareVersions(tpl.version, newest);
  if (order < 0)
    fail(title, 'Your template is ' + tpl.version + '; the current one is ' + newest + '. Merge it before you submit: git fetch upstream --tags, then git merge v' + newest + ', then npm install, npm run check and node store-check.mjs.');
  else if (order > 0 && from === 'the platform')
    fail(title, 'template.json says ' + tpl.version + ', newer than the current release ' + newest + '. Put back the template\'s copy: git checkout v' + newest + ' -- template.json');
  else pass(title, tpl.version + ' (from ' + from + ')');
}

run();
await currentRelease();
audit();

let failed = 0;
for (const r of results) {
  const tag = !r.ok ? 'FAIL' : r.warn ? 'NOTE' : 'PASS';
  if (!r.ok) failed += 1;
  console.log(tag + '  ' + r.title + ': ' + r.note);
  for (const p of r.paths ?? []) console.log('        ' + p);
}
console.log(
  failed
    ? '\n' + (failed === 1 ? '1 check failed. Fix it' : failed + ' checks failed. Fix them') + ', then run node store-check.mjs again.'
    : '\nEvery check passed. Commit, push, then submit the branch in the developer portal.'
);
process.exitCode = failed ? 1 : 0;
