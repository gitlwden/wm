# 面板数据修复指南

本文档列出所有无数据显示的面板及其修复方案。

## 1. ECONOMIC WARFARE 面板

**状态**: ✅ 已修复

**问题**: 之前面板无数据显示，已修复

**修复方案**: 
- 无需 Redis 键 `economic:economic_warfare:v1`
- 数据通过 `economicAdapter` 从 `ctx.latestMarkets` 和 `ctx.latestClusters` 实时收集
- 修复提交：`95c355c6` - 降低相关性阈值从 20 到 15，市场变化阈值从 1.5% 到 1.0%

**数据来源**:
- 商品和加密货币市场实时报价
- 制裁相关新闻聚类

---

## 2. Social Velocity 面板

**状态**: 需要数据源

**问题**: Redis 键 `social:trending-topics:v1` 不存在

**修复步骤**:
1. 检查 API 端点 `/api/social/v1/list-trending-topics`
2. 创建种子脚本从社交媒体 API 获取数据
3. 设置定期更新

---

## 3. WSB Ticker Scanner 面板

**状态**: 需要数据源

**问题**: Redis 键 `forecast:wsb_sentiment:v1` 不存在

**修复步骤**:
1. 检查 API 端点 `/api/forecast/wsb-sentiment`
2. 创建种子脚本从 Reddit WSB 获取情绪数据
3. 设置定期更新

---

## 4. Grocery Index / Big Mac Index 面板

**状态**: 需要 Railway seed 脚本

**问题**: Redis 键 `economic:grocery-basket:v1` 和 `economic:bigmac:v1` 不存在

**修复步骤**:
1. 检查 Railway 上的 seed-bigmac.mjs 和 seed-grocery-basket.mjs
2. 确保外部 API 可访问
3. 验证 cron 调度

---

## 5. Hormuz Trade Tracker 面板

**状态**: 需要数据源

**问题**: Redis 键 `supply_chain:hormuz_tracker:v1` 不存在

**修复步骤**:
1. 检查 AIS 数据源连接
2. 验证种子脚本运行状态
3. 确保数据格式匹配前端期望

---

## 6. Sanctions & Designations 面板

**状态**: 需要 OFAC 数据种子

**问题**: OFAC 种子脚本未运行或数据不可用

**修复步骤**:
1. 检查 `scripts/seed-sanctions.mjs`
2. 验证 OFAC API 连接
3. 设置定期同步

---

## 7. Daily / Latest Brief 面板

**状态**: 需要 PRO 订阅和认证

**问题**: 需要 Clerk 认证和 PRO 订阅

**修复步骤**:
1. 确保用户已登录
2. 验证 PRO 订阅状态
3. 检查 `/api/latest-brief` 端点

---

## 通用修复流程

### 步骤 1: 验证 Redis 连接
```bash
# 检查 Redis 连接
redis-cli ping
```

### 步骤 2: 检查种子脚本
```bash
# 运行特定种子脚本
node scripts/seed-xxx.mjs
```

### 步骤 3: 验证数据格式
确保种子脚本写入的数据格式与前端期望的 Proto 消息格式匹配。

### 步骤 4: 设置定时任务
在 Railway 或类似服务上设置 cron 任务定期运行种子脚本。

---

## 优先级排序

| 优先级 | 面板 | 影响范围 | 修复难度 |
|--------|------|----------|----------|
| ~~高~~ | ~~Economic Warfare~~ | ~~高~~ | ~~中~~ | ✅ 已修复
| 高 | Sanctions & Designations | 高 | 中 |
| 中 | Hormuz Trade Tracker | 中 | 高 |
| 中 | Big Mac Index | 中 | 低 |
| 低 | Social Velocity | 低 | 中 |
| 低 | WSB Ticker Scanner | 低 | 中 |
| 低 | Grocery Index | 低 | 低 |

---

## 监控建议

1. 为所有种子脚本添加健康检查端点
2. 设置 Redis 键过期告警
3. 监控前端数据加载失败率
4. 定期检查外部数据源可用性