import { createHash, randomUUID } from 'node:crypto';
import type { Pool, RowDataPacket } from 'mysql2/promise';
import type { FileFavorite } from '../../protocol/file-favorite-types.js';
import { HttpError } from '../../util/errors.js';

export interface FileFavoriteRepository {
  list(): Promise<FileFavorite[]>;
  save(projectId: string, path: string): Promise<FileFavorite>;
  remove(id: string): Promise<void>;
}

type FavoriteRow = RowDataPacket & {
  id: string; project_id: string; path: string; created_at: Date | string;
  project_name: string; working_directory: string; project_status: FileFavorite['projectStatus'];
};
const selection = `SELECT f.id,f.project_id,f.path,f.created_at,p.name AS project_name,
  p.working_directory,p.status AS project_status FROM file_favorites f JOIN projects p ON p.id=f.project_id
  WHERE p.removed_at IS NULL AND p.status<>'deleting'`;
const favorite = (row: FavoriteRow): FileFavorite => ({ id: row.id, projectId: row.project_id, path: row.path,
  createdAt: new Date(row.created_at).toISOString(), projectName: row.project_name,
  workingDirectory: row.working_directory, projectStatus: row.project_status });

/** The installation has one operator identity, shared with projects and sessions. */
export class MySqlFileFavoriteRepository implements FileFavoriteRepository {
  constructor(private readonly pool: Pool) {}

  async init() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS file_favorites (
      id CHAR(36) PRIMARY KEY,project_id CHAR(36) NOT NULL,path TEXT NOT NULL,
      path_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,created_at DATETIME(3) NOT NULL,
      UNIQUE KEY file_favorites_location(project_id,path_hash),INDEX file_favorites_created(created_at,id),
      CONSTRAINT file_favorites_project_fk FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
  }

  async list() {
    const [rows] = await this.pool.query<FavoriteRow[]>(`${selection} ORDER BY f.created_at DESC,f.id DESC`);
    return rows.map(favorite);
  }

  async save(projectId: string, path: string) {
    const hash = createHash('sha256').update(path).digest('hex');
    await this.pool.query(`INSERT INTO file_favorites(id,project_id,path,path_hash,created_at)
      SELECT ?,p.id,?,?,? FROM projects p WHERE p.id=? AND p.removed_at IS NULL AND p.status<>'deleting'
      ON DUPLICATE KEY UPDATE id=file_favorites.id`, [randomUUID(), path, hash, new Date(), projectId]);
    const [rows] = await this.pool.query<FavoriteRow[]>(`${selection} AND f.project_id=? AND f.path_hash=?`, [projectId, hash]);
    if (!rows[0]) throw new HttpError(404, '项目不存在或正在删除');
    return favorite(rows[0]);
  }

  async remove(id: string) { await this.pool.query('DELETE FROM file_favorites WHERE id=?', [id]); }
}
