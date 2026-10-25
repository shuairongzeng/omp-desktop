# R8 E2E 契约（v2 协议）—— 唯一定义，三方照此编码

## 帧总览（全部 JSON 文本帧；新增类型用 **加粗** 标出）

| 帧 | 方向 | 明文/密文 | 说明 |
|---|---|---|---|
| hello / peer / device / device_info / ping/pong / pair_* / paired / **pair_done** / revoke / list_phones | 控制 | 明文 | relay 现有路由语义不变 |
| **hs** | phone↔desktop | 明文（只含公钥+MAC） | 每连接一次的会话密钥握手 |
| **enc** | phone↔desktop | **密文信封** | 所有业务帧（cmd/res/evt，含 sub/unsub、含 gz 压缩值）一律装进 enc |

## 配对期（建立 MS，一次）

1. 手机用 `?pair=<pair-token>` 连上后立刻发 `{"t":"pair_hello","pk":"<b64 32B X25519>"}`（ephemeral，配对专用）。
2. relay 把 pk 存进 Pairing session，转发桌面时 `pair_request` 增加可选字段 `"pk"`。
3. 桌面批准时 `pair_grant` 增加 `"pk"`（桌面 ephemeral pub）：`{"t":"pair_grant","pair_id":"…","pk":"…"}`。
4. relay 在 `paired` 里带回桌面 pk：`{"t":"paired","device":"…","token":"…","pk":"…"}`，并**随后给桌面**发 `{"t":"pair_done","pair_id":"…","ph":"<phone token sha256 hex>"}`。
5. 双方计算 `MS = HKDF-SHA256(ikm=X25519(my_priv, peer_pk), salt=phone_pk||desk_pk, info="omp-e2e-master-v2")`（32 字节）。salt 不含 pair_id：配对 ephemeral 每次全新，且手机在线上根本拿不到 pair_id。
6. 存储：手机 → localStorage 设备条目加 `ms`（b64）；桌面 → `remote.json` 的 phone 条目（以 `ph` 为键）加 `ms`。**旧配对无 ms → 视为未配对，UI 显示"请重新配对"**（硬性切换，无明文回退）。

## 每连接会话握手（hs，前向保密）

手机连上（`?role=phone&device=&token=`）后第一帧：
`{"t":"hs","v":2,"ph":"<token sha256 hex>","pk":"<b64 eph>","mac":"<b64>"}`
`mac = HMAC-SHA256(key=HKDF(MS, salt="", info="omp-e2e-hs-mac-v2"), msg="P"||phone_pk)`

桌面回：`{"t":"hs","v":2,"pk":"<b64 eph>","mac":"<b64>"}`
`mac = HMAC-SHA256(同 key, msg="D"||desk_pk||phone_pk)`

会话密钥：`shared = X25519(my_eph, peer_eph_pk)`，`salt = phone_pk||desk_pk`
`K_c2d = HKDF(shared, salt, "omp-e2e-c2d-v2")`，`K_d2c = HKDF(shared, salt, "omp-e2e-d2c-v2")`（各 32B，AES-256-GCM）

MAC 校验失败 → 立即关闭连接（桌面侧记 warn 日志；手机侧显示"密钥校验失败，请重新配对"）。

## 加密帧

`{"t":"enc","seq":<u64>,"d":"<b64>"}`，可选 `"to":"<phone-conn-id>"`（仅桌面→手机，见路由）
- `d` = AES-256-GCM(明文帧 JSON 序列化) ‖ 16B tag，base64
- nonce：12 字节 = 4B 全零 ‖ u64 BE seq（**每方向独立计数，从 0 开始**；不同方向用不同密钥，无复用）
- AAD = utf8 字节串 `enc:<seq>`（十进制）
- 收方强制 seq 严格递增（允许跳号，不允许回退/重复 → 重放防护）
- gz 压缩在**加密之内**（先 gz 装 `{gz:…}` 帧，再整体加密）

## relay 路由规则（C 组实现）

- `hs`/`pair_hello`：按角色转发（phone→desktop / desktop→对应 phone via pairing phone_tx）。
- `enc` phone→desktop：照旧 `from` 打标后给桌面。
- `enc` desktop→phone：**有 `to` → 单播该 conn**；无 `to` → 广播（v2 桌面总是带 `to`，广播仅为兼容）。
- relay 给桌面的 phone `peer` 帧增加 `"conn":"<conn-id>","ph":"<hash>"`（桌面维护 conn→密钥映射）。
- 信封校验：`enc` 需整数 `seq` + 字符串 `d`；`hs` 需字符串 `pk`,`mac`；新增类型进 frame.rs 白名单与测试。
- 桌面广播 evt 时**对每台在线手机单独加密、逐台单播**（各手机密钥不同）。

## 能力协商与错误

- hello `caps` 增加 `"e2e"`，`v: 2`。
- 桌面 v2 收到明文 cmd/res 之外的…（明文 cmd 一律拒绝）：回 `{"t":"res","id":…,"ok":false,"error":"e2e required — reload the phone page"}`。
- 手机 shim 发现桌面 hello 无 `e2e` → 阻断 invoke，UI 报"请升级桌面端"。
- 部署顺序：relay（+其托管的 dist 手机页）→ 桌面安装包。过渡期手机页会提示升级桌面，属预期。

## 测试向量（双方各自通过标准向量即互操作）

- AES-256-GCM：NIST GCM 公开向量；X25519：RFC 7748 向量；HKDF-SHA256：RFC 5869 Case 1。
- 集成期我做一次跨端实测向量（Rust 加密 → noble 解密），外加真链路密文抓包断言。

## 威胁模型（如实记录进 remote-control.md）

- 配对瞬间 relay 仍可信（pair token 由 relay 铸造）——主动 MITM 仅限配对窗口，属已知残余，文档写明。
- 配对之后 relay 被动可见的只有：信封类型、seq、时间戳、流量大小。内容不可读、不可篡改（GCM tag）、不可重放（seq 单调）。
