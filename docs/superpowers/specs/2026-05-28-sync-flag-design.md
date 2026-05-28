# `--sync` 플래그 설계

날짜: 2026-05-28

## 배경

`seu`는 `.env` 파일과 AWS SSM Parameter Store 간 업로드/다운로드를 지원한다.

- `seu <env>` — 로컬 `.env` → SSM 업로드
- `seu <env> --get` — SSM → 로컬 `.env` 다운로드

현재는 로컬에서 키를 삭제해도 SSM에는 이전 값이 그대로 남는다(고아 파라미터). 로컬을 기준으로 SSM을 완전히 일치시키는 동기화 수단이 필요하다.

## 목표

`seu <env> --sync` 를 추가한다. 동작은 **업로드 + 고아 삭제**:

1. 기존 업로드 동작을 그대로 수행한다.
2. SSM에는 있지만 로컬 `.env`에는 없는 파라미터(고아)를 찾아, 사용자 확인 후 SSM에서 삭제한다.

## 결정 사항

- **범위**: 업로드 + 고아 삭제 (삭제만 수행하는 모드는 아님).
- **안전장치**: 삭제 대상 목록을 출력하고 `y/N` 확인을 받는다. 기본값은 N. (별도 `--force` 없음.)
- **방향**: 업로드 방향(`--sync`)만 대상. `--get`에는 sync 동작을 추가하지 않는다.

## CLI 동작

```
seu dev --sync
```

1. 로컬 `.env.dev`의 키 집합을 읽는다.
2. `/{basePath}/dev/` 하위 SSM 파라미터 전체를 조회한다 (기존 `--get` 조회 로직 재사용).
3. 기존 업로드 동작을 수행한다 (로컬 값 → SSM).
4. 고아 파라미터(SSM에는 있지만 로컬에 없는 키) 목록을 출력한다.
5. 고아가 있으면 `Delete N parameter(s) from SSM? (y/N)` 프롬프트를 띄운다.
   - `y` → 삭제 실행
   - 그 외 → 삭제 생략 (업로드는 이미 완료된 상태)
6. 고아가 없으면 "삭제할 항목 없음"을 안내하고 종료한다.

출력 예시:

```
Uploading .env.dev to Parameter Store...
Upload completed: /myapp/dev (15 items)

Found 2 parameter(s) in SSM not present locally:
  - OLD_API_KEY
  - DEPRECATED_TOKEN
Delete 2 parameter(s) from SSM? (y/N):
```

## 코드 변경 (접근 A — 최소 변경)

현재 `src/main.ts`의 절차적 스타일을 유지한다.

- **공유 헬퍼 추출**: `--get` 블록 내부의 `fetchParametersSync`와 `fullBasePath` 계산을 상단 공용 영역으로 올려 `--get`/`--sync`가 공유한다.
- **업로드 함수화**: 하단 업로드 워커 루프를 `uploadAll(envParams)` 형태로 묶어 `seu <env>`와 `seu <env> --sync`가 공유한다.
- **`--sync` 분기 추가** (`process.argv[3] === "--sync"`): 업로드 → 고아 계산 → 프롬프트 → 삭제.
- **삭제 실행**: `aws ssm delete-parameters --names ...` (호출당 최대 10개)로 배치 삭제. 삭제 대상은 SSM 조회 결과의 전체 `Name`(예: `/myapp/dev/OLD_KEY`)을 그대로 사용한다.
- **확인 입력**: Node `readline`로 `y/N`을 읽는다 (기본 N).

## 엣지 케이스

- **고아 판정 기준**: 로컬 `.env` 파일에 존재하는 **모든 키**(값이 비어 있어도 포함) 기준으로 비교한다. 빈 값 키는 업로드는 건너뛰지만(기존 동작) 삭제 대상으로는 보지 않는다 → 실수 삭제 방지.
- **중첩 경로 파라미터 제외**: SSM 조회는 `--recursive`라 `/{basePath}/{env}/GROUP/KEY`처럼 한 단계 더 깊은 파라미터도 반환된다. 이 경우 파생 키가 `GROUP/KEY`(`/` 포함)가 되는데, dotenv 키에는 `/`가 없으므로 절대 로컬과 매칭되지 않아 항상 고아로 잡히는 문제가 있다. 따라서 파생 키에 `/`가 포함된(= flat 하지 않은) 파라미터는 **삭제 후보에서 제외**한다. 이 도구가 관리하는 flat 네임스페이스(`/{basePath}/{env}/KEY`)만 동기화 대상으로 본다.
- **고아 없음**: 안내 출력 후 정상 종료.
- **사용자가 N 입력**: 업로드는 완료 상태로 두고 삭제만 생략.
- **삭제 일부 실패**: `delete-parameters`의 `InvalidParameters`를 경고로 출력하되 전체를 실패 처리하지 않는다.

## 검증

- `npm run build`(tsc) 통과.
- 테스트용 SSM 경로에 더미 파라미터를 두고 수동 확인. (테스트 프레임워크 없음 — 확인 프롬프트가 dry-run 역할.)

## 범위 밖 (YAGNI)

- `--force`/`--yes` 같은 무확인 삭제 플래그.
- `--get`에 대한 로컬 측 동기화.
- 자동 테스트 프레임워크 도입.
