// Package store 打开唯一的 SQLite 文件并建表；发全局短号。
// 其余包拿 *DB 自己写参数化查询，写入一律走 Tx。
package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

type DB struct{ *sql.DB }

// Querier 是 *sql.DB 与 *sql.Tx 的共同部分；只读函数收它，调用方决定在不在事务里。
type Querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Open 建目录（0700）、打开库并建表。WAL、外键、忙等 5 秒；事务一律 BEGIN IMMEDIATE，
// 免得两个读后写的事务在升级写锁时互相等死。
func Open(path string) (*DB, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Set("_txlock", "immediate")
	sqlDB, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	if _, err := sqlDB.Exec(schema); err != nil {
		sqlDB.Close()
		return nil, fmt.Errorf("建表失败：%w", err)
	}
	return &DB{sqlDB}, nil
}

// Tx 在一个事务里跑 fn；fn 返回错误就回滚。
func (db *DB) Tx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// Now 是库里统一的时间单位：Unix 毫秒。
func Now() int64 { return time.Now().UnixMilli() }

// Prefixes 是全部短号前缀：任务、部门、要点、负责人、选项单、资料、机器、周期任务。
var Prefixes = map[string]string{
	"t": "任务", "o": "部门", "k": "要点", "a": "负责人", "c": "选项单",
	"m": "资料", "h": "机器", "s": "周期任务",
}

// NextID 发下一个短号（如 t12）。必须在写事务里调用，与插入同一事务，失败回滚则号也不占。
func NextID(ctx context.Context, q Querier, prefix string) (string, error) {
	if _, ok := Prefixes[prefix]; !ok {
		return "", fmt.Errorf("未知短号前缀 %q", prefix)
	}
	var n int64
	err := q.QueryRowContext(ctx,
		`INSERT INTO ids (prefix, last) VALUES (?, 1)
		 ON CONFLICT (prefix) DO UPDATE SET last = last + 1
		 RETURNING last`, prefix).Scan(&n)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%s%d", prefix, n), nil
}

// Null 把空串存成 NULL（可空外键列用）。
func Null(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// IsNotFound 判断 QueryRow 的无结果错误。
func IsNotFound(err error) bool { return errors.Is(err, sql.ErrNoRows) }
