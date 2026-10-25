# Infinite Canvas MCP

你正在通过 MCP 工具遥控用户的无限画布（infinite-canvas）。所有画布操作都在用户的浏览器页面中实时执行，用户可以看到每一步效果。

## 前置条件

- 画布执行器运行在浏览器页面里：**用户必须先打开画布 Web 页面（默认 http://localhost:5070）**，否则工具调用会返回 `executor_offline` 错误。收到该错误时，引导用户打开页面后重试。
- 操作具体画布前，先用 `site_navigate` 跳转到 `/canvas/:id`（画布 ID 来自 `canvas_list_projects`）。

## 工具分组

- **项目管理**：`canvas_list_projects`（列画布）、`site_navigate`（跳转页面）。
- **画布操作**：`canvas_apply_ops` 是核心批量入口，op 类型包括 `add_node`、`update_node`、`delete_node`、`delete_connections`、`connect_nodes`、`set_viewport`、`select_nodes`、`run_generation`；另有 `canvas_create_text_node(s)`、`canvas_create_generation_flow`、`canvas_delete_nodes`、`canvas_connect_nodes` 等便捷封装，以及 `canvas_get_state` / `canvas_get_selection` / `canvas_export_snapshot` 读取类工具。
- **生成**：`canvas_run_generation` 触发节点上的图像/视频/音频/文本生成（异步执行，用 `generation_get_status` 查询状态）。
- **镜头**：`shot_create` / `shot_list` / `shot_update` / `shot_delete` / `shot_link` / `shot_fork` 管理视频编排镜头。
- **工作台与素材**：`workbench_image_*`、`workbench_video_*`、`prompts_search`、`assets_list`、`assets_add`。
- **导演台**：`stage_*` / `camera_*` / `preview_*` 由 3D 导演台页面执行器执行，使用前先 `stage_open`。

## 操作建议

- 批量改动优先用一次 `canvas_apply_ops` 提交多个 op，减少往返。
- `add_node` 不传 x 时节点放在当前画布最右侧；用 `canvas_get_state` 了解现有布局再决定坐标。
- 生成流程优先用 `canvas_create_generation_flow`（自动创建提示词节点、配置节点并连线）。
- 长耗时操作（视频生成、预演导出）是异步的：提交后用状态查询工具轮询，不要假设立即完成。
