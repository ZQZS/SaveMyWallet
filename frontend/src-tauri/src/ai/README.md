# DeepSeek 原生适配器

原生客户端使用当前设备保存的用户密钥访问 DeepSeek 官方 HTTPS API。月度解释接收所选月份的四项汇总值，分期条件解析接收本轮问题及参考月份，识图接收系统选择器生成的临时图片标识。金额计算和草稿确认在客户端完成。[助手使用说明](../../../docs/ai-features.md)

- Windows 使用 Credential Manager 保存密钥，安卓使用 Keystore 管理加密密钥，并将 API Key 密文保存在应用私有目录。设置页可以查询配置状态、替换或移除密钥。账本备份和同步分别沿用原有数据格式。
- 选图后原生层提供预览及临时图片标识。识图请求使用该标识对应的图片，识别成功、结束录入或改选时释放标识。审核页可继续用本次预览与草稿逐笔对照。
- 原生请求使用固定的 DeepSeek 服务地址。密钥只随 HTTPS 授权头发送。模型文案和结构化草稿返回界面，用户确认后通过现有账本会话写入 SQLite。

[命令注册](../lib.rs) · [月度上下文字段](../../../src/integrations/ai/capabilities.ts) · [识图草稿字段](../../../src/integrations/ai/visionDrafts.ts)
