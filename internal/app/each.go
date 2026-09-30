package app

import (
	"context"
	"database/sql"
	"errors"

	"github.com/liu-zhengdong/atrium/internal/store"
)

// Each 是后台批量处理的入口。列表读取错误由调用方返回；单件错误交给 failed
// 落到该件上，然后继续。父 ctx 取消、连接失效和 SQLite 基础设施错误直接返回。
// 子操作自己的超时属于单件错误，不能据此停止服务。
// NotNow 不是失败：这一轮跳过，不调用 failed，下一轮再试。
func Each[T any](ctx context.Context, db *store.DB, items []T, run func(T) error, failed func(T, error) error) error {
	for _, item := range items {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := run(item); err != nil {
			if IsNotNow(err) {
				continue
			}
			if fatal := InfrastructureError(ctx, db, err); fatal != nil {
				return fatal
			}
			if err := failed(item, err); err != nil {
				return err
			}
		}
	}
	return nil
}

// Global 标明共享读取或整轮动作的错误，即使它不是 SQL 错误也不能归给某件。
func Global(err error) error {
	if err == nil {
		return nil
	}
	return globalError{err}
}

type globalError struct{ error }

func (e globalError) Unwrap() error { return e.error }

// InfrastructureError 只识别与单件无关的故障。SQLite 约束失败由该件负责；
// IO、损坏、锁、SQL/表结构错误等不能被转成任务受阻而掩盖。
func InfrastructureError(ctx context.Context, db *store.DB, err error) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	var global globalError
	if errors.As(err, &global) {
		return err
	}
	var coded interface{ Code() int }
	if errors.As(err, &coded) && coded.Code()&255 != 19 {
		return err
	} // SQLITE_CONSTRAINT
	if errors.Is(err, sql.ErrConnDone) || errors.Is(err, sql.ErrTxDone) {
		return err
	}
	if e := db.PingContext(ctx); e != nil {
		return e
	}
	return nil
}
