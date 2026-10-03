package platform

import "os"

const logLimit = 8 << 20
const logTail = 2 << 20

// trimLog 在打开追加前就地保留最近 2MiB，不更换文件或生成轮转段。
func trimLog(f *os.File) error {
	st, err := f.Stat()
	if err != nil || st.Size() <= logLimit {
		return err
	}
	tail := make([]byte, logTail)
	if _, err := f.ReadAt(tail, st.Size()-logTail); err != nil {
		return err
	}
	if _, err := f.WriteAt(tail, 0); err != nil {
		return err
	}
	return f.Truncate(logTail)
}
