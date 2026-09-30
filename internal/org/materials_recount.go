package org

import (
	"context"
	"database/sql"
	"fmt"
	"os"

	"github.com/liu-zhengdong/atrium/internal/app"
	"github.com/liu-zhengdong/atrium/internal/store"
)

func initMaterials(ctx context.Context, env *app.Env) error {
	n, err := mergeFlatMaterials(ctx, env.DB, env.Paths.Data)
	if err != nil {
		return err
	}
	if n > 0 {
		env.Log.Info("按文件平铺的旧资料已合并", "groups", n)
	}
	return recountMaterials(ctx, env.DB, env.Paths.Data)
}

// recountMaterials 一次重算全部版本（含归档资料）；计量与完成标记同事务提交。
func recountMaterials(ctx context.Context, db *store.DB, data string) error {
	return db.Tx(ctx, func(tx *sql.Tx) error {
		var done int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM material_metering WHERE version = 1`).Scan(&done); err != nil {
			return err
		}
		if done != 0 {
			return nil
		}
		type file struct {
			id, path string
			rev      int
		}
		last := file{}
		for {
			rows, err := tx.QueryContext(ctx, `SELECT id, rev, path FROM material_files
    WHERE (id, rev, path) > (?, ?, ?) ORDER BY id, rev, path LIMIT 100`, last.id, last.rev, last.path)
			if err != nil {
				return err
			}
			var files []file
			for rows.Next() {
				var f file
				if err := rows.Scan(&f.id, &f.rev, &f.path); err != nil {
					rows.Close()
					return err
				}
				files = append(files, f)
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return err
			}
			if len(files) == 0 {
				break
			}
			for _, f := range files {
				raw, err := os.ReadFile(materialFile(data, f.id, f.rev, f.path))
				if err != nil {
					return fmt.Errorf("重算资料 %s r%d/%s：%w", f.id, f.rev, f.path, err)
				}
				units, binary := Units(f.path, raw)
				if _, err := tx.ExecContext(ctx, `UPDATE material_files SET units = ?, binary = ? WHERE id = ? AND rev = ? AND path = ?`, units, binary, f.id, f.rev, f.path); err != nil {
					return err
				}
			}
			last = files[len(files)-1]
		}
		if _, err := tx.ExecContext(ctx, `UPDATE materials SET
   units = COALESCE((SELECT sum(f.units) FROM material_files f WHERE f.id = materials.id AND f.rev = materials.rev), 0),
   binary = COALESCE((SELECT f.binary FROM material_files f WHERE f.id = materials.id AND f.rev = materials.rev AND f.path = materials.file), 0)`); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `INSERT INTO material_metering (version) VALUES (1)`)
		return err
	})
}
