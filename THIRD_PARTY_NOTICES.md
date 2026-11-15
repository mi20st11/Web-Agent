# 第三方素材与许可证

Web Agent 本体以 AGPL-3.0 发布。下面这一项是唯一的外部素材，单独按 Apache License 2.0 授权。

## 鲸鱼娘（精致版）看板娘序列帧

- 来源项目：`zhu1090093659/dsh-pet`（DSH 生态里的桌面宠物插件）
  - 仓库：https://github.com/zhu1090093659/dsh-pet
  - 素材路径：`assets/whale-refined/spritesheet.webp`、`assets/whale-refined/pet.json`
  - 使用版本（commit）：`ae2c9d443eda35a6439597c1787c7607e988bbed`
  - 上游聚合仓库：https://github.com/zhu1090093659/dsh-web（`packages/dsh-web-all`、`satellites/dsh-pet`）
- 许可证：Apache License, Version 2.0（全文见 [LICENSE-APACHE-2.0.txt](LICENSE-APACHE-2.0.txt)）
  - 上游素材清单 `pet.json` 另标注该图集为 MIT；两种许可都允许在保留声明的前提下使用与修改。
- 版权：Copyright (c) dsh-pet contributors
- 本项目的修改：
  - 只取图集第 0 行 `idle` 的 6 帧（原图 1536×1872，8 列 × 9 行，单元格 192×208）；
  - 按 6 帧的并集透明边界裁切，等比缩放到 132×143；
  - 拼成 792×143 的横向序列帧，重编码为 WebP（约 44 KB），以 data URI 内联在 `ui/index.html`；
  - 逐帧时长沿用上游 `pet.json`：500 / 500 / 600 / 500 / 500 / 600 ms；
  - 未改动人物形象本身。
- 使用位置：`ui/index.html` 侧栏底部的 `.mascot-sprite`，对应代码注释里也标注了上述来源与许可证。

Apache License 2.0 第 4 条要求的版权声明、许可声明与修改说明均在本文件与 `ui/index.html` 的注释中保留。
