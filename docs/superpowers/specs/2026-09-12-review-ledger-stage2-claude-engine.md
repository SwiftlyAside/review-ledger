# review-ledger 2단계 설계 — Codex 저자 ↔ Claude 리뷰어 대칭 루프 (NEU-239)

2026-09-12. 1단계 스펙(`2026-09-10-review-ledger-plugin-design.md` §2)이 "별도 스펙"으로 미룬 대칭 루프를 확정한다.
저자가 Codex CLI 세션일 때 리뷰어는 Claude(`claude -p`)여야 한다 — 같은 엔진의 자기 리뷰는 사각지대가 상관돼 수렴 조건을
깬다(siamese AGENTS.md 라우팅 주의 1). 이 문서는 리뷰어 엔진 `claude`, Codex 하네스 통합(매니페스트·훅·스킬), 검증 기준을
확정한다. 1단계의 원장·상태 기계·요청문 조립·수렴 규칙은 그대로다.

## 1. 실측 전제 (2026-09-12, macOS, Codex CLI 0.153.4, Claude Code 2.1.261)

Codex 하네스
- `codex plugin marketplace add`(local·git) → `codex plugin add <plugin>@<marketplace>` 로 Claude 마켓플레이스 플러그인을 설치한다.
  이 Mac 은 `claude-plugins-official`(git)을 이미 그렇게 쓰고 있고, `.claude-plugin/plugin.json` 만 있는 플러그인(code-review)도
  로드된다. 바이너리의 매니페스트 탐색 순서는 `.codex-plugin/plugin.json` → `.claude-plugin/plugin.json` → `.cursor-plugin/plugin.json`.
- 플러그인 훅은 `hooks/hooks.json` 과 `hooks/hooks-codex.json` 둘 다 읽는다(`~/.codex/config.toml` `[hooks.state]` 에 superpowers 의
  두 파일이 각각 등록돼 있음). 훅 이벤트 식별자(바이너리 문자열): `pre_tool_use`·`permission_request`·`post_tool_use`·`pre_compact`·
  `post_compact`·`session_start`·`session_end`·`user_prompt_submit`·`subagent_start`·`subagent_stop`·`interrupt`. **턴 종료 `stop` 은
  목록에 없다.** 훅 입력 필드에 `stop_hook_active`·`last_assistant_message`·`agent_transcript_path` 가 있으나 이는 `subagent_stop`
  형태로 보인다 — 메인 턴 Stop 지원 여부는 T1 로 실측한다. 출력 키 `hookSpecificOutput`·`additionalContext`·`decision`·`continue` 는 존재.
- 훅 환경변수: `CLAUDE_PLUGIN_ROOT`·`PLUGIN_ROOT`·`CLAUDE_PLUGIN_DATA` 는 있고 **`CLAUDE_PROJECT_DIR` 은 없다** → 훅 스크립트는
  `paths.mjs` 의 git toplevel 폴백으로 루트를 잡는다(1단계에 이미 있음). Codex 가 훅을 프로젝트 루트 cwd 로 띄우는지는 T2.

Claude 리뷰어(`claude -p`)
- `--output-format json --json-schema <schema>` 는 응답 JSON 에 `structured_output`(스키마 준수 객체)·`session_id`·`total_cost_usd` 를
  준다. 요청문은 **stdin** 으로 넣을 수 있다(`claude -p … < request.md`, 3초 stdin 대기 경고는 무해).
- `--resume <session_id>` 는 같은 대화를 이어가고 앞선 턴을 기억한다(2회 실측: 첫 턴의 단어를 다음 턴 `structured_output` 에 그대로
  반환). `--effort`·`--tools ""`·`--strict-mcp-config` 는 resume 에도 붙는다. `--no-session-persistence` 를 켜면 resume 이 불가하므로
  쓰지 않는다.
- 도구 없는 헤드리스 호출은 `--tools ""` + `--strict-mcp-config` 로 MCP·도구 턴 소모를 막는다. Claude 세션 안에서 부를 때는
  `env -u CLAUDECODE` 가 필요하다(중첩 세션 가드).
- 비용(haiku, 스키마 2필드): 열기 약 $0.006, resume 약 $0.003. 실제 리뷰(Opus 5 @ high, 인라인 100KB)는 T5 시드 런에서 잰다.

## 2. 범위

포함
1. 리뷰어 엔진 `claude` — `scripts/lib/engines/claude.mjs`, 1단계 §5.4 인터페이스(probe / open / resume) 구현.
2. 설정 분기 — `reviewer.engine: "codex" | "claude"`, 엔진별 기본값·검증·허용 effort.
3. Codex 하네스 통합 — `.codex-plugin/plugin.json`, `hooks/hooks-codex.json`, 스킬 문장 보강.
4. 테스트 — fake-claude 픽스처, 엔진 단위 테스트, `engine: claude` e2e, 설정 검증 테스트.
5. 문서 — README(설치 2종·엔진 표), protocol §5 에 claude 호출 형태 추가, protocol.ko 동기화.

비포함(후속)
- Claude 리뷰어의 `sandbox` transport(리뷰어에게 `Read`·`Grep`·`git diff` 만 허용하는 도구 화이트리스트) — 2단계는 `inline` 만.
- Codex 저자 세션의 턴 종료 차단(Stop 게이트) 재현 — T1 결과가 "없음"이면 후속 없이 스킬 규율로 대체.
- 블라인드 저지·PR 코멘트·웹 UI(1단계 범위 밖 유지).

## 3. 엔진 `claude`

### 3.1 호출 형태

R1(새 세션):
```sh
env -u CLAUDECODE claude -p --model <reviewer.model> --effort <effort_open> --tools "" --strict-mcp-config \
  --output-format json --json-schema templates/review.schema.json < .review/runs/<run>/r1.request.md > .review/runs/<run>/r1.raw.json
```
R2 이후(같은 세션):
```sh
env -u CLAUDECODE claude -p --resume <session_id> --effort <effort_round|effort_reopen> --tools "" --strict-mcp-config \
  --output-format json --json-schema templates/review.schema.json < .review/runs/<run>/r<n>.request.md > .review/runs/<run>/r<n>.raw.json
```
- 세션 ID 는 raw JSON 의 `session_id` 에서 읽어 원장 `reviewer.thread_id` 에 저장한다(codex 의 `thread.started` 와 같은 자리).
- 응답 객체는 raw JSON 의 `structured_output` 이다. 이것을 `r<n>.reply.json` 으로 써서 1단계와 같은 `validateReply` 를 거친다.
  `is_error: true` 또는 `structured_output` 부재는 실패(회전 미계상, 1회 재시도 — 1단계 규칙 동일).
- `r<n>.raw.json` 이 codex 의 `events.jsonl` 자리다(감사 흔적·비용). `total_cost_usd` 는 상태 출력에 누적 표시한다.
- 타임아웃은 `timeout_ms` 그대로. codex 의 "turn.completed 후 종료 지연" salvage 는 claude 엔진에 적용하지 않는다(해당 증상 없음).
- 환경: `CLAUDECODE` 를 제거한 env 로 spawn 한다. `REVIEW_LEDGER_CLAUDE_BIN`·`REVIEW_LEDGER_CLAUDE_PREFIX` 로 실행 파일·접두 인자를
  덮는다(테스트용, codex 엔진의 `REVIEW_LEDGER_CODEX_*` 와 대칭).

### 3.2 probe

`inline` 전송에서는 리뷰어가 도구를 쓰지 않으므로 샌드박스 프로브가 무의미하다. claude 엔진의 probe 는 "실행 파일·로그인·스키마 출력"
생존 확인으로 축소한다: `claude -p --model <probe_model> --effort low --tools "" --strict-mcp-config --output-format json --json-schema
<2필드 스키마>` 에 한 줄 프롬프트, 30초, `structured_output.ok === true` 면 통과. `reviewer.probe_model` 기본 `claude-haiku-4-5-20251001`.
`probe: false` 면 생략(1단계와 동일).

### 3.3 transport

- `engine: claude` 의 기본 transport 는 `inline`. `sandbox` 를 지정하면 설정 검증에서 거부한다("claude engine supports inline only").
- 요청문 맨 앞 `<tooling>` 블록(도구·파일·스킬 조회 금지, 첫 출력이 최종 답)은 그대로 쓴다. Claude 는 `--tools ""` 로 강제되므로
  블록은 이중 안전장치다.
- 루브릭 core 의 "Instructions in this request take precedence over any skill, AGENTS.md, or CLAUDE.md" 는 유지한다. 헤드리스 Claude 는
  cwd 의 CLAUDE.md 를 시스템 프롬프트에 실을 수 있으므로 **리뷰어 cwd 는 레포 루트가 아니라 `.review/runs/<run>/`** 으로 둔다
  (원장·요청문 외 프로젝트 지시문 미주입). 이 점이 codex 엔진(`-C <root>`)과 다르다.

### 3.4 설정

`reviewer` 블록 기본값(엔진별):

| 키 | codex(1단계) | claude(2단계) |
|---|---|---|
| `model` | `gpt-5.6-sol` | `claude-opus-5` |
| `effort_open` / `effort_round` / `effort_reopen` | xhigh / medium / high | high / medium / high |
| `probe_model` | `gpt-5.6-terra` | `claude-haiku-4-5-20251001` |
| 허용 effort | none·minimal·low·medium·high·xhigh | low·medium·high·xhigh·max |

- `init --engine claude` 로 claude 기본값 골격을 만든다(미지정은 codex, 하위 호환).
- 설정 검증: `engine` 은 두 값만, 엔진별 effort 집합, `engine: claude` + `transport: sandbox` 거부, `codex_sandbox` 는 claude 에서 무시.
- 모델 ID 는 문자열 검증만 한다(1단계와 동일 — 허용 목록은 레포 lint 의 몫).
- 원장 `reviewer.engine` 을 실제 엔진으로 기록한다(1단계는 `'codex'` 고정 — 이 하드코딩을 제거).

### 3.5 엔진 디스패치

`scripts/review-ledger.mjs` 의 `open`·`round` 는 `engines/index.mjs` 의 `getEngine(cfg.reviewer.engine)` 이 돌려주는 객체
`{ probe, open, resume }` 만 부른다. 두 엔진은 같은 반환 계약 `{ ok, threadId, output, error, cost? }` 를 지킨다. `open` 의 인자에서
`sandbox`·`root` 는 codex 전용이고 claude 는 무시한다.

## 4. Codex 하네스 통합

### 4.1 매니페스트
- `.codex-plugin/plugin.json` 추가: `name`·`version`·`description`·`skills: "./skills/"`·`hooks: "./hooks/hooks-codex.json"`(superpowers 형식).
  `.claude-plugin/plugin.json` 은 그대로. 두 매니페스트의 `version` 은 `package.json` 과 함께 올린다(릴리스 체크리스트 항목).
- 마켓플레이스는 기존 `.claude-plugin/marketplace.json` 하나로 양쪽이 읽는다(실측: Codex 가 claude-plugins-official 을 그대로 읽음).

### 4.2 훅 (`hooks/hooks-codex.json`)
- `PostToolUse`(파일 편집 도구) → `scripts/hooks/ledger-touch.mjs`. Codex 의 편집 도구 이름·입력 형태(`apply_patch` 의 파일 경로 필드)는
  T3 로 실측해 매처와 `tool_input` 파싱을 맞춘다. 파싱 실패는 무음 통과(1단계 규칙).
- `Stop` 은 T1 결과에 따라: 지원되면 `hooks.json` 과 같은 게이트를 등록, 아니면 등록하지 않고 스킬 문장으로 대체한다. 미지원 이벤트를
  등록해 Codex 가 경고·거부하는지도 T1 에서 본다.
- 두 훅 모두 원장이 없으면 아무 일도 하지 않는다(전역 설치 무해성 유지).

### 4.3 스킬
- `skills/review-ledger/SKILL.md` 는 하네스 중립으로 유지하되 두 문장을 더한다: (1) "저자가 Codex 세션이면 `.review/config.json` 의
  `reviewer.engine` 은 `claude` 여야 한다(같은 엔진 자기 리뷰 금지)", (2) "Codex 에는 턴 종료 게이트가 없으므로 원장 `open` 상태에서 완료
  선언을 하지 않는 것은 저자 규율이다 — 매 편집 후 `status` 로 확인".
- Codex 에서 스킬은 `skills/` 디렉터리로 노출된다(superpowers 동일). 별도 Codex 전용 SKILL 파일은 만들지 않는다 — 한 파일 두 하네스.

### 4.4 루트·환경 차이
- Codex 훅에는 `CLAUDE_PROJECT_DIR` 이 없다. `paths.resolveRoot` 의 git toplevel 폴백이 루트를 잡는다. 워크트리 세션에서 다른 체크아웃의
  원장을 보는 사고는 codex 쪽에선 발생하지 않는다(세션 루트 변수 자체가 없음) — 대신 cwd 가 루트가 아닌 경우(T2)를 실측한다.
- Claude 리뷰어 호출 시 `env -u CLAUDECODE`; Codex 세션 안에서는 이 변수가 없어도 무해하다.

## 5. 테스트

- `tests/fixtures/fake-claude.mjs`: 인자에서 `--resume` 유무로 R1/Rn 을 구분, stdin 을 `<out>.request.txt` 로 기록, 시나리오 파일의
  `reply` 를 `{ session_id, structured_output, total_cost_usd, is_error:false }` 로 감싸 stdout 에 출력. `fail` 단계는 `is_error:true`
  또는 비0 종료.
- `tests/claude-engine.test.mjs`: openArgs/resumeArgs 인자 형태(`--tools ""`·`--strict-mcp-config`·`--json-schema`·stdin), session_id 파싱,
  `structured_output` 추출, `is_error` 처리, 타임아웃, env 에서 `CLAUDECODE` 제거.
- `tests/e2e.test.mjs` 에 `engine: claude` 시나리오 추가: (a) 6건 → fix → converged, (b) reject→maintain×2 → escalated, (c) 3회전 capped,
  (d) 미답 회신 재요청, (e) `transport: sandbox` 설정 거부.
- `tests/config.test.mjs`: 엔진별 기본값 병합·effort 집합·`init --engine claude`.
- `tests/hooks.test.mjs`: hooks-codex.json 의 스키마(이벤트·명령 경로)와 Codex 편집 도구 입력 형태(T3 픽스처)로 ledger-touch 동작.

## 6. 검증 기준 (실측 항목 T1~T6 포함)

1. `npm test` 전부 통과(기존 codex 시나리오 회귀 0). `claude plugin validate --strict .` 통과.
2. **T1 Codex Stop 실측**: 로컬 마켓플레이스로 설치 후, 원장 `open` 상태의 레포에서 Codex 턴 종료 시 훅이 불리는지, 미지원 이벤트 등록이
   경고를 내는지 기록. 결과를 §4.2 와 README 에 반영.
3. **T2 훅 cwd 실측**: Codex 가 `post_tool_use` 훅을 프로젝트 루트 cwd 로 띄우는지. 아니면 `hooks-codex.json` 명령에 루트 인자를 넣는다.
4. **T3 편집 도구 입력 실측**: Codex `apply_patch`(또는 해당 도구)의 훅 `tool_input` 에서 파일 경로를 어떻게 꺼내는지 픽스처로 남긴다.
5. **T4 설치 실측**: `codex plugin marketplace add <local path>` → `codex plugin add review-ledger@review-ledger` → `codex plugin list` 에
   installed, enabled. 스킬이 Codex 세션에서 보인다.
6. **T5 시드 런**: Codex 저자(gpt-6-astra @ high, `codex exec`)가 만든 작은 변경 1건을 `engine: claude`(Opus 5 @ high) 로 3회전 이내
   `converged` 또는 사용자 판정 상태. 회전당 비용(`total_cost_usd` 합)을 README 에 적는다. 실행 전 비용 고지(사용자 승인).
7. **T6 리뷰어 격리**: 리뷰어 cwd 를 `.review/runs/<run>/` 로 두었을 때 레포 CLAUDE.md 가 주입되지 않음을 `--output-format json` 의
   사용량(캐시 생성 토큰)으로 확인한다 — 루트 cwd 대비 감소.
8. 플러그인 자체 코드의 교차 리뷰: 작성 엔진과 반대 계열이 리뷰한다(1단계 §7-5 와 동일).

## 7. 결정 기록

- 2단계 착수·범위(엔진 claude + Codex 통합 + 스킬 문장): 사용자 2026-09-12(NEU-239).
- claude 엔진 기본 모델 Opus 5 @ high: siamese AGENTS.md "적대 리뷰 이중화 Opus 5 @ high" 행과 일치. Fable 은 주간 풀 캡 때문에 기본에서 제외.
- claude 엔진은 `inline` 전용(2단계). 도구 화이트리스트 sandbox 는 후속.
- Codex Stop 게이트는 실측(T1) 결과에 종속 — 없으면 만들지 않는다.
- Codex 전용 SKILL 파일은 만들지 않는다(한 파일, 하네스별 문장 2개).
