package workers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"unicode/utf8"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// RunAt 按经历中已登记的轮次选日志；0保持最近一轮语义，路径不由调用者拼接。
func RunAt(ctx context.Context, q store.Querier, task string, n int) (*Run, error) {
	if n == 0 {
		return LastRun(ctx, q, task)
	}
	var body string
	err := q.QueryRowContext(ctx, `SELECT body FROM task_events WHERE task = ? AND kind = ? AND json_extract(body, '$.n') = ? ORDER BY id DESC LIMIT 1`, task, RunKind, n).Scan(&body)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var r Run
	if err := json.Unmarshal([]byte(body), &r); err != nil {
		return nil, err
	}
	return &r, nil
}

// ReadRawLog 不依赖换行，包含退出前没有换行的错误；每块至多256 KiB。
func ReadRawLog(path string, offset int64) (string, int64, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer f.Close()
	if offset < 0 {
		offset = 0
	}
	b := make([]byte, logChunk)
	n, err := f.ReadAt(b, offset)
	if err != nil && err != io.EOF {
		return "", 0, err
	}
	b = b[:n]
	// 避免在UTF-8字符中间分块；工具日志为文本。
	if n == logChunk {
		for len(b) > 0 && !utf8.Valid(b) && n-len(b) < utf8.UTFMax {
			b = b[:len(b)-1]
		}
	}
	if !utf8.Valid(b) {
		return "", offset, fmt.Errorf("日志包含非UTF-8字节，不能经JSON返回完整原文")
	}
	return string(b), offset + int64(len(b)), nil
}
