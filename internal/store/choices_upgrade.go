package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// choicesDefinition 只从现行 schema 取表定义，避免升级另存一份列定义。
func choicesDefinition() string {
	start := strings.Index(schema, "CREATE TABLE IF NOT EXISTS choices (")
	end := strings.Index(schema[start:], ");") + start + 2
	return schema[start:end]
}

func normalizeDDL(s string) string {
	s = strings.Replace(s, "IF NOT EXISTS ", "", 1)
	s = strings.Replace(s, `CREATE TABLE "choices"`, `CREATE TABLE choices`, 1)
	return strings.Join(strings.Fields(strings.TrimSuffix(strings.TrimSpace(s), ";")), " ")
}

// upgradeChoices 仅接受已确认的旧 choices；新库与现行结构不复制数据。
func upgradeChoices(ctx context.Context, db *sql.DB) error {
	conn, err := db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	return upgradeChoicesConn(ctx, conn)
}

func upgradeChoicesConn(ctx context.Context, conn *sql.Conn) (err error) {
	var ddl string
	err = conn.QueryRowContext(ctx, `SELECT sql FROM sqlite_schema WHERE type='table' AND name='choices'`).Scan(&ddl)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	current := choicesDefinition()
	if normalizeDDL(ddl) == normalizeDDL(current) {
		return nil
	}
	old := strings.Replace(current, "'passed', 'void'", "'passed'", 1)
	if normalizeDDL(ddl) != normalizeDDL(old) {
		return fmt.Errorf("未知 choices 结构，停止升级")
	}

	if _, err = conn.ExecContext(ctx, `PRAGMA foreign_keys=OFF`); err != nil {
		return err
	}
	defer func() {
		_, restoreErr := conn.ExecContext(context.Background(), `PRAGMA foreign_keys=ON`)
		err = errors.Join(err, restoreErr)
	}()
	return rebuildChoices(ctx, conn, current)
}

func rebuildChoices(ctx context.Context, conn *sql.Conn, current string) error {
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// 显式索引也在同一事务保存、恢复；自动唯一索引由现行表定义建立。
	rows, err := tx.QueryContext(ctx, `SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name='choices' AND sql IS NOT NULL ORDER BY name`)
	if err != nil {
		return err
	}
	var indexes []string
	for rows.Next() {
		var index string
		if err = rows.Scan(&index); err != nil {
			rows.Close()
			return err
		}
		indexes = append(indexes, index)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, statement := range []string{
		strings.Replace(current, "IF NOT EXISTS choices", "choices_upgrade", 1),
		`INSERT INTO choices_upgrade SELECT * FROM choices`,
		`DROP TABLE choices`,
		`ALTER TABLE choices_upgrade RENAME TO choices`,
	} {
		if _, err = tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	for _, index := range indexes {
		if _, err = tx.ExecContext(ctx, index); err != nil {
			return err
		}
	}
	rows, err = tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return err
	}
	broken := rows.Next()
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if broken {
		return fmt.Errorf("升级后外键检查失败")
	}
	return tx.Commit()
}
