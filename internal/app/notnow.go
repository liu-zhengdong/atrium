package app

import "errors"

// notNowError 表示这一轮先不做，不是这件活失败。后台按件循环见到它就跳过，下一轮再试。
type notNowError struct{ error }

func (e notNowError) Unwrap() error { return e.error }

// NotNow 包一层「下一轮再试」。err 为 nil 时返回 nil。
func NotNow(err error) error {
	if err == nil {
		return nil
	}
	return notNowError{err}
}

// IsNotNow 报告 err 链上有没有 NotNow。
func IsNotNow(err error) bool {
	var n notNowError
	return errors.As(err, &n)
}
