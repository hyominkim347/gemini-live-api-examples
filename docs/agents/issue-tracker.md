# Issue Tracker

이 저장소의 작업은 Linear에서 관리합니다.

## 대상

- Workspace: `Allganize`
- Team: `AIN`
- Project: `meeting`
- CLI: `orca linear`

GitHub Issues나 upstream 저장소에는 이 프로젝트의 작업을 발행하지 않습니다.

## 새 이슈 기본값

- 상태: `Backlog`
- 담당자: 없음
- 본문: 실행에 필요한 전체 명세와 완료 조건을 이슈 설명에 기록
- 라벨: 실행 가능한 수준으로 명세가 확정된 경우에만 `ready-for-agent` 적용

새 이슈를 만들기 전에 `AIN / meeting` 범위에서 중복 작업을 검색합니다. 현재 worktree에 연결된 Linear 이슈가 없으면 연결을 추측하지 말고 이슈 키나 URL을 명시합니다.

## 읽기

```bash
orca linear issue AIN-123 --full --json
orca linear list-issues --team AIN --project meeting --json
```

## 쓰기

이슈 생성이 현재 작업 범위에서 명시적으로 승인된 경우에만 실행합니다.

```bash
orca linear create \
  --team AIN \
  --project meeting \
  --state Backlog \
  --title "<title>" \
  --body-file <path> \
  --json
```

실행 준비가 확인된 뒤에는 기존 라벨을 추가합니다.

```bash
orca linear label add AIN-123 --label ready-for-agent --json
```

상태, 담당자, 라벨을 변경할 때는 기존 이슈를 다시 읽고 대상 이슈가 맞는지 확인합니다. 설정 문서 작성 자체는 Linear 이슈 생성이나 변경을 승인하지 않습니다.
