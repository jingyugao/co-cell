#!/usr/bin/env bash

set -uo pipefail

DEFAULT_URL='https://project.feishu.cn/example-project/story/detail/1234567890?parentUrl=%2Fexample-project%2Fstory%2Fhomepage&openScene=4'
WORK_ITEM_URL="${1:-$DEFAULT_URL}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
RUN_ID="$(date '+%Y%m%d-%H%M%S')"
OUTPUT_ROOT="${MEEGLE_TEST_OUTPUT_ROOT:-$REPO_ROOT/tmp/docs/meegle-readonly-test}"
OUTPUT_DIR="$OUTPUT_ROOT/$RUN_ID"
MANIFEST="$OUTPUT_DIR/manifest.tsv"
SUMMARY="$OUTPUT_DIR/summary.md"
COMBINED="$OUTPUT_DIR/meegle-readonly-combined.md"

mkdir -p "$OUTPUT_DIR"
printf 'name\tdescription\texit_code\n' >"$MANIFEST"

quote_command() {
  local arg
  printf '%q ' "$@"
  printf '\n'
}

run_capture() {
  local name="$1"
  local description="$2"
  shift 2

  local command_file="$OUTPUT_DIR/$name.command.sh"
  local stdout_file="$OUTPUT_DIR/$name.stdout.json"
  local stderr_file="$OUTPUT_DIR/$name.stderr.log"
  local exit_file="$OUTPUT_DIR/$name.exit_code"
  local exit_code

  {
    printf '#!/usr/bin/env bash\n'
    quote_command "$@"
  } >"$command_file"
  chmod +x "$command_file"

  "$@" >"$stdout_file" 2>"$stderr_file"
  exit_code=$?
  printf '%s\n' "$exit_code" >"$exit_file"
  printf '%s\t%s\t%s\n' "$name" "$description" "$exit_code" >>"$MANIFEST"
  printf '[%s] exit=%s %s\n' "$name" "$exit_code" "$description"

  return "$exit_code"
}

require_success() {
  local name="$1"
  if [[ ! -f "$OUTPUT_DIR/$name.exit_code" ]] || [[ "$(<"$OUTPUT_DIR/$name.exit_code")" != '0' ]]; then
    printf 'Required check failed: %s. See %s\n' "$name" "$OUTPUT_DIR/$name.stderr.log" >&2
    exit 1
  fi
}

if ! command -v meegle >/dev/null 2>&1; then
  printf 'meegle CLI is not installed or not in PATH.\n' >&2
  exit 127
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'jq is required to parse JSON responses.\n' >&2
  exit 127
fi

# These are deliberately read-only commands. Do not add create/update/add/transition calls.
run_capture '00-auth-status' '检查用户 OAuth 登录状态' \
  meegle auth status --format json
require_success '00-auth-status'

if [[ "$(jq -r '.authenticated // false' "$OUTPUT_DIR/00-auth-status.stdout.json")" != 'true' ]]; then
  printf 'Meegle is not authenticated. Run: meegle auth login --host project.feishu.cn\n' >&2
  exit 1
fi

run_capture '01-url-decode' '解析工作项 URL' \
  meegle url decode --url "$WORK_ITEM_URL" --format json
require_success '01-url-decode'

URL_KIND="$(jq -r '.url_kind // empty' "$OUTPUT_DIR/01-url-decode.stdout.json")"
SIMPLE_NAME="$(jq -r '.simple_name // empty' "$OUTPUT_DIR/01-url-decode.stdout.json")"
WORK_ITEM_TYPE="$(jq -r '.work_item_type // empty' "$OUTPUT_DIR/01-url-decode.stdout.json")"
WORK_ITEM_ID="$(jq -r '.work_item_id // empty' "$OUTPUT_DIR/01-url-decode.stdout.json")"

if [[ "$URL_KIND" != 'workitem_detail' ]] || [[ -z "$SIMPLE_NAME" ]] || [[ -z "$WORK_ITEM_TYPE" ]] || [[ -z "$WORK_ITEM_ID" ]]; then
  printf 'The URL is not a supported work-item detail URL. url_kind=%s\n' "$URL_KIND" >&2
  exit 1
fi

run_capture '02-project-search' '将空间 simple_name 转为权威 project_key' \
  meegle project search --project-key "$SIMPLE_NAME" --format json
require_success '02-project-search'

PROJECT_COUNT="$(jq -r '.projects | length' "$OUTPUT_DIR/02-project-search.stdout.json")"
if [[ "$PROJECT_COUNT" != '1' ]]; then
  printf 'Expected exactly one accessible project, got %s.\n' "$PROJECT_COUNT" >&2
  exit 1
fi

PROJECT_KEY="$(jq -r '.projects[0].project_key' "$OUTPUT_DIR/02-project-search.stdout.json")"
PROJECT_NAME="$(jq -r '.projects[0].name' "$OUTPUT_DIR/02-project-search.stdout.json")"

run_capture '03-workitem-get-basic' '查看工作项基础信息' \
  meegle workitem get \
    --project-key "$PROJECT_KEY" \
    --work-item-id "$WORK_ITEM_ID" \
    --format json

run_capture '04-workitem-get-all-fields' '查看工作项全部逻辑字段（含描述、人员、可能的附件字段）' \
  meegle workitem get \
    --project-key "$PROJECT_KEY" \
    --work-item-id "$WORK_ITEM_ID" \
    --fields '["_all"]' \
    --params '{"page_size":200}' \
    --format json

run_capture '05-workflow-get-node' '查看全部流程节点、负责人、排期和子任务' \
  meegle workflow get-node \
    --project-key "$PROJECT_KEY" \
    --work-item-id "$WORK_ITEM_ID" \
    --params '{"node_id_list":["_all"],"field_key_list":["_all"],"need_sub_task":true,"page_num":1}' \
    --format json

run_capture '06-comment-list' '查看评论第一页' \
  meegle comment list \
    --project-key "$PROJECT_KEY" \
    --work-item-id "$WORK_ITEM_ID" \
    --page-num 1 \
    --format json

run_capture '07-op-records-page-01' '查看操作记录第一页' \
  meegle workitem list-op-records \
    --project-key "$PROJECT_KEY" \
    --work-item-id "$WORK_ITEM_ID" \
    --format json

# Fetch additional operation-record pages when the API returns a continuation cursor.
OP_PAGE=1
OP_CURSOR=''
if [[ "$(<"$OUTPUT_DIR/07-op-records-page-01.exit_code")" == '0' ]]; then
  OP_CURSOR="$(jq -r '.start_from // .next_start_from // .pagination.start_from // empty' "$OUTPUT_DIR/07-op-records-page-01.stdout.json")"
fi
while [[ -n "$OP_CURSOR" ]] && (( OP_PAGE < 20 )); do
  OP_PAGE=$((OP_PAGE + 1))
  PAGE_NAME="$(printf '07-op-records-page-%02d' "$OP_PAGE")"
  run_capture "$PAGE_NAME" "查看操作记录第 $OP_PAGE 页" \
    meegle workitem list-op-records \
      --project-key "$PROJECT_KEY" \
      --work-item-id "$WORK_ITEM_ID" \
      --start-from "$OP_CURSOR" \
      --format json
  if [[ "$(<"$OUTPUT_DIR/$PAGE_NAME.exit_code")" != '0' ]]; then
    break
  fi
  NEXT_CURSOR="$(jq -r '.start_from // .next_start_from // .pagination.start_from // empty' "$OUTPUT_DIR/$PAGE_NAME.stdout.json")"
  if [[ -z "$NEXT_CURSOR" ]] || [[ "$NEXT_CURSOR" == "$OP_CURSOR" ]]; then
    break
  fi
  OP_CURSOR="$NEXT_CURSOR"
done

run_capture '08-relation-meta-definitions' '查看空间中的工作项关系定义' \
  meegle relation meta-definitions \
    --project-key "$PROJECT_KEY" \
    --work-item-type "$WORK_ITEM_TYPE" \
    --format json

if [[ "$(<"$OUTPUT_DIR/08-relation-meta-definitions.exit_code")" == '0' ]]; then
  RELATION_INDEX=0
  while IFS=$'\t' read -r relation_id relation_name; do
    [[ -n "$relation_id" ]] || continue
    RELATION_INDEX=$((RELATION_INDEX + 1))
    RELATION_RESULT_NAME="$(printf '09-relation-list-%02d' "$RELATION_INDEX")"
    run_capture "$RELATION_RESULT_NAME" "查看关联工作项：$relation_name" \
      meegle relation list \
        --project-key "$PROJECT_KEY" \
        --work-item-id "$WORK_ITEM_ID" \
        --relation-id "$relation_id" \
        --page-num 1 \
        --page-size 50 \
        --format json
  done < <(jq -r '.list[]? | [.id, .name] | @tsv' "$OUTPUT_DIR/08-relation-meta-definitions.stdout.json")
fi

run_capture '10-deliverable-list' '查看该工作项的交付物' \
  meegle deliverable list \
    --project-key "$PROJECT_KEY" \
    --work-item-ids "$WORK_ITEM_ID" \
    --format json

run_capture '11-workitem-meta-types' '查看空间工作项类型字典' \
  meegle workitem meta-types \
    --project-key "$PROJECT_KEY" \
    --format json

run_capture '12-workitem-meta-fields' '查看当前工作项类型的字段字典第一页' \
  meegle workitem meta-fields \
    --project-key "$PROJECT_KEY" \
    --work-item-type "$WORK_ITEM_TYPE" \
    --page-num 1 \
    --format json

run_capture '13-workitem-meta-roles' '查看当前工作项类型的角色字典第一页' \
  meegle workitem meta-roles \
    --project-key "$PROJECT_KEY" \
    --work-item-type "$WORK_ITEM_TYPE" \
    --page-num 1 \
    --format json

MQL="$(printf 'SELECT `work_item_id`, `name`, `work_item_status`, `priority` FROM `%s`.`%s` WHERE `work_item_id` = %s LIMIT 1' "$SIMPLE_NAME" "$WORK_ITEM_TYPE" "$WORK_ITEM_ID")"
run_capture '14-workitem-query' '用 MQL 查询该工作项' \
  meegle workitem query \
    --project-key "$PROJECT_KEY" \
    --mql "$MQL" \
    --format json

run_capture '15-mywork-todo' '查看当前用户进行中的待办第一页' \
  meegle mywork todo \
    --action todo \
    --todo-scope in_progress \
    --page-num 1 \
    --format json

# There is no attachment-list command. Extract attachment-like fields from the full work-item response.
run_capture '16-attachment-field-scan' '从完整工作项响应中筛选附件/文件字段（本地只读解析）' \
  jq '[.. | objects | select((.field_type? == "multi-file") or (.type? == "multi-file") or ((.field_name? // "") | test("附件|文件")))]' \
    "$OUTPUT_DIR/04-workitem-get-all-fields.stdout.json"

SUCCESS_COUNT="$(awk -F '\t' 'NR > 1 && $3 == 0 {count++} END {print count + 0}' "$MANIFEST")"
RAW_FAILURE_COUNT="$(awk -F '\t' 'NR > 1 && $3 != 0 {count++} END {print count + 0}' "$MANIFEST")"
NOT_APPLICABLE_COUNT=0
if grep -q 'ErrNotDeliverableWorkItem' \
  "$OUTPUT_DIR/10-deliverable-list.stdout.json" \
  "$OUTPUT_DIR/10-deliverable-list.stderr.log"; then
  NOT_APPLICABLE_COUNT=1
fi
FAILURE_COUNT=$((RAW_FAILURE_COUNT - NOT_APPLICABLE_COUNT))

{
  printf '# Meegle 只读功能测试\n\n'
  printf -- '- 执行时间：`%s`\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
  printf -- '- Meegle 版本：`%s`\n' "$(meegle --version 2>/dev/null || true)"
  printf -- '- 工作项 URL：%s\n' "$WORK_ITEM_URL"
  printf -- '- 空间：%s (`%s`)\n' "$PROJECT_NAME" "$PROJECT_KEY"
  printf -- '- 工作项类型：`%s`\n' "$WORK_ITEM_TYPE"
  printf -- '- 工作项 ID：`%s`\n' "$WORK_ITEM_ID"
  printf -- '- 成功：%s；不适用：%s；失败：%s\n\n' "$SUCCESS_COUNT" "$NOT_APPLICABLE_COUNT" "$FAILURE_COUNT"
  printf '## 结果索引\n\n'
  printf '| 编号 | 功能 | 退出码 | 命令 | 标准输出 | 标准错误 |\n'
  printf '|---|---|---:|---|---|---|\n'
  tail -n +2 "$MANIFEST" | while IFS=$'\t' read -r name description exit_code; do
    printf '| `%s` | %s | %s | [%s.command.sh](./%s.command.sh) | [%s.stdout.json](./%s.stdout.json) | [%s.stderr.log](./%s.stderr.log) |\n' \
      "$name" "$description" "$exit_code" "$name" "$name" "$name" "$name" "$name" "$name"
  done
  printf '\n## 说明\n\n'
  printf -- '- 全部 Meegle 调用均为只读命令。\n'
  printf -- '- 每项分别保存了可重放命令、标准输出、标准错误和退出码。\n'
  printf -- '- `attachment-field-scan` 是本地 `jq` 解析；Meegle CLI 没有附件列表命令，附件引用随工作项字段或评论返回。\n'
  printf -- '- `mywork-todo` 只保存第一页，避免无边界拉取个人工作台数据。\n'
  printf -- '- 普通需求调用 `deliverable list` 可能返回 `ErrNotDeliverableWorkItem`；这表示目标不是交付物类型，原始返回仍会保留。\n'
} >"$SUMMARY"

{
  printf '# Meegle 只读功能测试：命令与完整返回\n\n'
  printf -- '- 执行时间：`%s`\n' "$(date '+%Y-%m-%d %H:%M:%S %z')"
  printf -- '- Meegle 版本：`%s`\n' "$(meegle --version 2>/dev/null || true)"
  printf -- '- 工作项 URL：%s\n' "$WORK_ITEM_URL"
  printf -- '- 空间：%s (`%s`)\n' "$PROJECT_NAME" "$PROJECT_KEY"
  printf -- '- 工作项类型：`%s`\n' "$WORK_ITEM_TYPE"
  printf -- '- 工作项 ID：`%s`\n' "$WORK_ITEM_ID"
  printf -- '- 成功：%s；不适用：%s；失败：%s\n\n' "$SUCCESS_COUNT" "$NOT_APPLICABLE_COUNT" "$FAILURE_COUNT"
  printf '> 本文件汇总所有只读测试的实际命令、退出码、标准输出和标准错误。\n\n'

  tail -n +2 "$MANIFEST" | while IFS=$'\t' read -r name description exit_code; do
    printf '## %s — %s\n\n' "$name" "$description"
    printf -- '- 退出码：`%s`\n\n' "$exit_code"
    printf '### 命令\n\n````bash\n'
    sed '1{/^#!\/usr\/bin\/env bash$/d;}' "$OUTPUT_DIR/$name.command.sh"
    printf '````\n\n'
    printf '### 标准输出\n\n````json\n'
    if [[ -s "$OUTPUT_DIR/$name.stdout.json" ]]; then
      sed -n '1,$p' "$OUTPUT_DIR/$name.stdout.json"
    else
      printf '(空)\n'
    fi
    printf '````\n\n'
    printf '### 标准错误\n\n````text\n'
    if [[ -s "$OUTPUT_DIR/$name.stderr.log" ]]; then
      sed -n '1,$p' "$OUTPUT_DIR/$name.stderr.log"
    else
      printf '(空)\n'
    fi
    printf '````\n\n'
  done

  printf '## 说明\n\n'
  printf -- '- 全部 Meegle 调用均为只读命令。\n'
  printf -- '- `attachment-field-scan` 是本地 `jq` 解析，未调用写接口。\n'
  printf -- '- `deliverable list` 的 `ErrNotDeliverableWorkItem` 表示该需求不是交付物类型，因此归类为“不适用”。\n'
} >"$COMBINED"

printf '%s\n' "$OUTPUT_DIR" >"$OUTPUT_ROOT/latest.txt"
printf '\nDone. Summary: %s\n' "$SUMMARY"
printf 'Combined report: %s\n' "$COMBINED"

if (( FAILURE_COUNT > 0 )); then
  exit 2
fi
