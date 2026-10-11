# kmst · 销售管理模块

给学员平台(`/opt/xiyejia-training`)加的「销售管理」模块:**商机管理 → 客户跟进 → 销售合同 → 销售交接**。

## 功能

| 菜单 | 功能 |
|------|------|
| 商机管理 | 录入意向客户。对接天眼查/企查查取统一社会信用代码;信用代码按国标 GB 32100 校验,并按「信用代码 + 企业名」双重查重,一家企业只能有一条商机 |
| 客户跟进 | 销售选择阶段(初次拜访 / 需求分析 / 方案提供 / 商务谈判)后录入跟进内容;跟进推进到后面的阶段时,商机阶段自动前进 |
| 销售合同 | 选商机、填模块明细与金额,按公司合同模板一键生成合同(金额自动转大写);可预览、打印、导出 Word;确认签订后商机自动标为「已成交」。模板和我方信息在后台可改 |
| 销售交接 | 已签订合同移交实施部,交接单含模块信息、主要需求、主要交接的价值点、主要风险点;实施部在系统里确认接收 |

| 数字销售总监 | 总经理、销售经理用。从销售填写的商机、跟进记录、合同和收款登记中统计每位销售的商机数量、跟进过程、成交率和收款情况;预警久未跟进、跟进逾期、应收未收;生成销售分析报告(逐人点评),也可以直接提问 |

**收款登记**:在「销售合同」打开已签订的合同,按实际到账逐笔登记收款(累计不超过合同金额),数字销售总监据此统计回款。

**数字销售总监**是平台自建 AI 员工(`agent/sales_director` → 平台 `custom/agents/sales_director`):

- 统计和预警按规则实时计算,不耗大模型额度。按商机负责人归属;成交率 = 已成交 ÷ 全部商机,赢单率 = 已成交 ÷ (已成交 + 已流失),都是累计口径;新增、跟进、签约、收款按所选区间统计;在跟商机超过 14 天没有跟进算「久未跟进」。
- 分析报告读每位销售的统计和跟进记录原文,点评跟进质量并给出建议(耗平台大模型额度);每周一 09:00 自动生成上周报告,通知总经理和销售经理。
- 「销售经理」角色在「实施管理 → 项目分配 → 团队成员」里设置。

## 实施管理

| 菜单 | 谁用 | 功能 |
|------|------|------|
| 项目分配 | 实施总监 | 销售交接单 → 分配实施顾问,设定实施完成时间和四个阶段节点;管理团队成员(可直接新建登录账号) |
| 我的项目 | 实施顾问 | 自己的项目列表:进度、当前阶段、是否超期;延期提醒、审核结果等消息 |
| 项目实施页 | 实施顾问 | 前期准备 → 蓝图设计 → 项目上线 → 验收交付,选阶段填写工作汇报、上传阶段文档、提交延期方案 |
| 数字总监 | 实施总监 / 总经理 | 「实施管理数字总监」AI 员工工作台:巡检、审核记录、延期审批、项目管理规范、向它提问 |
| 问题清单 | 总经理 | 数字总监每天汇总的在实施项目问题清单(可打印/导出 Word)与全部待整改问题 |

**实施管理数字总监**是平台自建 AI 员工(`agent/impl_director` → 平台 `custom/agents/impl_director`):

- 每小时巡检:阶段或项目超期 → 生成延期记录、提醒实施顾问提交延期方案(未提交每 24 小时再提醒),不耗大模型额度;
- 每份汇报提交后,按「公司项目管理规范」审核(耗平台大模型额度),不通过时列出问题、通知顾问,并更新当天问题清单提交总经理;
- 每天 18:00 汇总一次问题清单;阶段申请完成且审核通过后自动进入下一阶段。

角色以「团队成员」里设置的为准;平台主管理员 admin 未设角色时拥有全部角色。

## 架构

平台规定不能改它的数据库表,界面也只能调它已有的接口,所以销售管理是一个**独立服务**:

```
浏览器 ──80──> nginx ─┬─ /sales-api/ ──> sales-crm (127.0.0.1:3100, Node 24 + 内置 SQLite)
                      └─ 其他        ──> 平台 (127.0.0.1:3000)
```

- 登录沿用后台账号:sales-crm 拿浏览器的 `app_session_id` Cookie 去平台 `auth.me` 核验身份。
- 数据库:`/var/lib/sales-crm/crm.db`,每天 02:30 备份到 `/var/backups/sales-crm/`(保留 30 份)。
- 界面:`ui/` 下的页面由 `deploy/apply-ui.mjs` 装进平台的 `client/`,再用平台的 `rebuild-ui.sh` 构建。

## 目录

```
sales-crm/            后端服务(零依赖)
  server.mjs          入口:HTTP + 登录校验
  lib/api.mjs         业务接口
  lib/db.mjs          表结构
  lib/contract.mjs    合同模板与渲染
  lib/lookup.mjs      天眼查/企查查
  lib/util.mjs        信用代码校验、金额大写
  lib/impl.mjs        实施管理接口
  lib/director.mjs    数字总监:巡检、审核、问题清单、定时任务
  lib/sales-director.mjs  数字销售总监:销售统计、预警、分析报告
  lib/files.mjs       实施文档存储与文字提取(txt/md/docx)
  backup.mjs          数据库与文档备份
agent/impl_director/  「实施管理数字总监」AI 员工(人设、审核原则、查询工具)
agent/sales_director/ 「数字销售总监」AI 员工(人设、统计口径、查询工具)
ui/client/src/        后台页面(React)
  pages/crm/*.tsx     销售管理
  pages/impl/*.tsx    实施管理
  lib/crmApi.ts lib/implApi.ts
deploy/
  deploy.sh           一键部署
  apply-ui.mjs        把页面/菜单/路由装进平台界面源码
  apply-theme.mjs     后台主题色改为蓝色(品牌红 → 蓝,按深浅对应替换)
  nginx-xiyejia.conf  nginx 配置
```

## 部署 / 更新

```bash
cd /root/kmst && git pull && bash deploy/deploy.sh
bash deploy/deploy.sh --skip-ui     # 只改了后端时用,不重建界面
```

平台升级或执行过 `update.sh --reset-ui` 后,界面会恢复官方版,重跑 `bash deploy/deploy.sh` 即可把销售管理装回去。

## 配置工商信息接口

编辑 `/etc/sales-crm.env`,填天眼查或企查查的密钥,然后 `pm2 restart sales-crm`:

```
TIANYANCHA_TOKEN=你的天眼查token
# 或
QICHACHA_KEY=你的企查查key
QICHACHA_SECRET=你的企查查secretKey
```

没配置时,新建商机需手动填写信用代码(仍会校验格式并查重)。

## 运维

```bash
pm2 logs sales-crm --lines 100 --nostream     # 日志
pm2 restart sales-crm                         # 重启
node /opt/sales-crm/backup.mjs                # 手动备份
```

## 驾校培训报名系统(driving-school)

独立服务,不改平台源码。学员手机扫码报名 → 填写基础信息、选择课程(A照/B照/C照)→ 阅读合同并手写签名 → 付款 → 自动生成电子培训合同。

| 入口 | 地址 |
| --- | --- |
| 学员报名(手机) | `http://<服务器IP>/driving/` |
| 管理后台 | `http://<服务器IP>/driving/admin`,密码见 `/etc/driving-school.env` 的 `DS_ADMIN_PASSWORD` |
| 电子合同 | `http://<服务器IP>/driving/contract/<报名凭证>`(付款后生成,可打印/存 PDF) |

后台功能:数据概览、报名学员(详情/确认线下收款/取消/导出 CSV)、课程价格维护、报名二维码下载、驾校信息与合同条款模板、付款方式切换。

- 服务 `/opt/driving-school`,pm2 进程 `driving-school`,端口 3200,nginx `/driving/` 转发
- 数据 SQLite `/var/lib/driving-school/ds.db`,每日 02:40 备份到 `/var/backups/driving-school`
- 付款方式:`在线支付(演示)` 不真实扣款;`线下缴费` 由后台「确认已线下收款」后生成合同。接入微信/支付宝需商户号后再开发
- 改价只影响新报名;合同在付款时生成快照,之后修改条款模板不影响已签合同

```bash
cd /root/kmst && git pull && bash deploy/deploy-driving.sh   # 部署 / 更新
pm2 logs driving-school --lines 100 --nostream               # 日志
```
