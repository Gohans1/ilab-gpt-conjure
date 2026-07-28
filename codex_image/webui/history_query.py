from __future__ import annotations

import base64
from contextlib import closing
import json
import sqlite3
from typing import Any, TYPE_CHECKING

from .history_organizer import HistoryOrganizer

if TYPE_CHECKING:
    from .task_index import SQLiteTaskIndex


RATIO_OTHER_VALUE = "__other__"


class HistoryQueryService:
    def __init__(
        self,
        task_index: SQLiteTaskIndex,
        organizer: HistoryOrganizer,
    ) -> None:
        self.task_index = task_index
        self.organizer = organizer

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.task_index.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute(
            "attach database ? as history_org",
            (str(self.organizer.path),),
        )
        connection.execute("pragma query_only = on")
        connection.execute("pragma busy_timeout = 5000")
        return connection

    def query(
        self,
        *,
        limit: int = 50,
        cursor: str | None = None,
        q: str = "",
        month: str = "",
        mode: str = "",
        status: str = "",
        prompt_mode: str = "",
        size: str = "",
        quality: str = "",
        ratio: str = "",
        orientation: str = "",
        backend: str = "",
        provider: str = "",
        archived: bool | None = None,
        favorite: bool | None = None,
        tag_ids: list[str] | None = None,
        untagged: bool = False,
        sort: str = "newest",
        direction: str = "next",
    ) -> dict[str, Any]:
        safe_limit = min(100, max(1, int(limit or 50)))
        sort_order = "oldest" if sort == "oldest" else "newest"
        page_direction = "previous" if direction == "previous" else "next"
        clean_tag_ids = list(
            dict.fromkeys(
                tag_id
                for value in (tag_ids or [])
                if (tag_id := str(value or "").strip())
            )
        )
        if untagged and clean_tag_ids:
            raise ValueError(
                "untagged cannot be combined with tag filters"
            )

        filter_values = {
            "cursor": cursor,
            "q": q,
            "month": month,
            "mode": mode,
            "status": status,
            "prompt_mode": prompt_mode,
            "size": size,
            "quality": quality,
            "ratio": ratio,
            "orientation": orientation,
            "backend": backend,
            "provider": provider,
            "archived": archived,
            "favorite": favorite,
            "tag_ids": clean_tag_ids,
            "untagged": untagged,
            "sort_order": sort_order,
            "page_direction": page_direction,
            "ratio_other_value": RATIO_OTHER_VALUE,
        }
        use_fts = bool(q.strip() and self.task_index.fts_enabled)
        where, params = _history_where(
            use_fts=use_fts,
            **filter_values,
        )
        select_sql = (
            "select task_id, created_at, updated_at, completed_at, "
            "terminal_at, status, mode, size, quality, prompt_mode, "
            "ratio, orientation, backend, provider, archived_at, "
            "generated_count, failed_count, total_count, thumbnail_url, "
            "prompt_preview from task_index"
        )
        order_clause = _history_order_clause(
            sort_order,
            page_direction,
        )
        sql = _history_sql(select_sql, where, order_clause)
        query_params = [*params, safe_limit + 1]

        with closing(self._connect()) as connection:
            try:
                rows = connection.execute(
                    sql,
                    tuple(query_params),
                ).fetchall()
            except sqlite3.OperationalError:
                if not use_fts:
                    raise
                where, params = _history_where(
                    use_fts=False,
                    **filter_values,
                )
                sql = _history_sql(select_sql, where, order_clause)
                rows = connection.execute(
                    sql,
                    (*params, safe_limit + 1),
                ).fetchall()

            has_more = len(rows) > safe_limit
            page_rows = rows[:safe_limit]
            if page_direction == "previous":
                page_rows = list(reversed(page_rows))
            organizations = _organization_payloads(
                connection,
                [str(row["task_id"]) for row in page_rows],
            )

        tasks: list[dict[str, Any]] = []
        for row in page_rows:
            task_id = str(row["task_id"])
            task = _history_row_response(row)
            task.update(organizations[task_id])
            tasks.append(task)

        next_cursor = (
            encode_history_cursor(
                str(page_rows[-1]["created_at"]),
                str(page_rows[-1]["task_id"]),
            )
            if page_direction == "next" and has_more and page_rows
            else None
        )
        previous_cursor = (
            encode_history_cursor(
                str(page_rows[0]["created_at"]),
                str(page_rows[0]["task_id"]),
            )
            if page_direction == "previous" and has_more and page_rows
            else None
        )
        return {
            "tasks": tasks,
            "next_cursor": next_cursor,
            "previous_cursor": previous_cursor,
        }

    def summary(self) -> dict[str, Any]:
        with closing(self._connect()) as connection:
            total = int(
                connection.execute(
                    "select count(*) from task_index"
                ).fetchone()[0]
            )
            archived_total = int(
                connection.execute(
                    """
                    select count(*)
                    from task_index
                    where archived_at != ''
                    """
                ).fetchone()[0]
            )
            favorite_total = int(
                connection.execute(
                    """
                    select count(*)
                    from task_index i
                    where exists (
                        select 1
                        from history_org.task_favorites f
                        where f.task_id = i.task_id
                    )
                    """
                ).fetchone()[0]
            )
            untagged_total = int(
                connection.execute(
                    """
                    select count(*)
                    from task_index i
                    where not exists (
                        select 1
                        from history_org.task_tags tt
                        where tt.task_id = i.task_id
                    )
                    """
                ).fetchone()[0]
            )
            tag_rows = connection.execute(
                """
                select t.tag_id, t.name, count(i.task_id) as count
                from history_org.tags t
                left join history_org.task_tags tt
                    on tt.tag_id = t.tag_id
                left join task_index i
                    on i.task_id = tt.task_id
                group by t.tag_id, t.name, t.name_key
                order by t.name_key, t.tag_id
                """
            ).fetchall()
            months = _count_rows(
                connection,
                "month_key",
                "month_key != ''",
                order_by="month_key desc",
            )
            modes = _mode_count_rows(connection)
            statuses = _count_rows(
                connection,
                "status",
                "status != ''",
            )
            prompt_modes = _count_rows(
                connection,
                "prompt_mode",
                "prompt_mode != ''",
            )
            sizes = _count_rows(
                connection,
                "size",
                "size != ''",
            )
            qualities = _count_rows(
                connection,
                "quality",
                "quality != ''",
            )
            ratios = _ratio_count_rows(connection)
            orientations = _count_rows(
                connection,
                "orientation",
                "orientation != ''",
            )
            backends = _count_rows(
                connection,
                "backend",
                "backend != ''",
            )
            providers = _count_rows(
                connection,
                "provider",
                "provider != ''",
            )
        return {
            "total": total,
            "archived_total": archived_total,
            "favorite_total": favorite_total,
            "untagged_total": untagged_total,
            "tags": [
                {
                    "tag_id": str(row["tag_id"]),
                    "name": str(row["name"]),
                    "count": int(row["count"]),
                }
                for row in tag_rows
            ],
            "months": [
                {"month": item["value"], "count": item["count"]}
                for item in months
            ],
            "modes": modes,
            "statuses": statuses,
            "prompt_modes": prompt_modes,
            "sizes": sizes,
            "qualities": qualities,
            "ratios": ratios,
            "orientations": orientations,
            "backends": backends,
            "providers": providers,
        }


def encode_history_cursor(created_at: str, task_id: str) -> str:
    raw = json.dumps(
        {"created_at": created_at, "task_id": task_id},
        ensure_ascii=False,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _decode_history_cursor(
    cursor: str | None,
) -> tuple[str, str] | None:
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        payload = json.loads(
            base64.urlsafe_b64decode(
                padded.encode("ascii")
            ).decode("utf-8")
        )
    except (ValueError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    created_at = str(payload.get("created_at") or "")
    task_id = str(payload.get("task_id") or "")
    return (
        (created_at, task_id)
        if created_at and task_id
        else None
    )


def _fts_query(query: str) -> str:
    terms = [
        term.replace('"', '""')
        for term in query.split()
        if term.strip()
    ]
    return (
        " AND ".join(f'"{term}"' for term in terms)
        if terms
        else '""'
    )


def _history_row_response(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "task_id": str(row["task_id"]),
        "created_at": str(row["created_at"]),
        "updated_at": str(row["updated_at"]),
        "completed_at": str(row["completed_at"]),
        "terminal_at": str(row["terminal_at"]),
        "status": str(row["status"]),
        "mode": str(row["mode"]),
        "size": str(row["size"]),
        "quality": str(row["quality"]),
        "prompt_mode": str(row["prompt_mode"]),
        "ratio": str(row["ratio"]),
        "orientation": str(row["orientation"]),
        "backend": str(row["backend"]),
        "provider": str(row["provider"]),
        "archived": bool(str(row["archived_at"])),
        "generated_count": int(row["generated_count"]),
        "failed_count": int(row["failed_count"]),
        "total_count": int(row["total_count"]),
        "thumbnail_url": str(row["thumbnail_url"]),
        "prompt_preview": str(row["prompt_preview"]),
    }


def _count_rows(
    connection: sqlite3.Connection,
    column: str,
    where: str,
    *,
    order_by: str = "count(*) desc, value",
) -> list[dict[str, Any]]:
    rows = connection.execute(
        f"""
        select {column} as value, count(*) as count
        from task_index
        where {where}
        group by {column}
        order by {order_by}
        """
    ).fetchall()
    return [
        {"value": str(row["value"]), "count": int(row["count"])}
        for row in rows
    ]


def _mode_count_rows(
    connection: sqlite3.Connection,
) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        select
            case
                when mode = 'generate' then 'generate'
                else 'edit'
            end as value,
            count(*) as count
        from task_index
        where mode != ''
        group by value
        order by case value when 'generate' then 0 else 1 end
        """
    ).fetchall()
    return [
        {"value": str(row["value"]), "count": int(row["count"])}
        for row in rows
    ]


def _ratio_count_rows(
    connection: sqlite3.Connection,
) -> list[dict[str, Any]]:
    rows = _count_rows(connection, "ratio", "ratio != ''")
    other_count = int(
        connection.execute(
            "select count(*) from task_index where ratio = ''"
        ).fetchone()[0]
    )
    if other_count:
        rows.append(
            {"value": RATIO_OTHER_VALUE, "count": other_count}
        )
    return rows


def _history_where(
    *,
    cursor: str | None,
    q: str,
    month: str,
    mode: str,
    status: str,
    prompt_mode: str,
    size: str,
    quality: str,
    ratio: str,
    orientation: str,
    backend: str,
    provider: str,
    archived: bool | None,
    favorite: bool | None,
    tag_ids: list[str],
    untagged: bool,
    sort_order: str,
    page_direction: str,
    ratio_other_value: str,
    use_fts: bool,
) -> tuple[list[str], list[Any]]:
    where: list[str] = []
    params: list[Any] = []
    if month:
        where.append("month_key = ?")
        params.append(month)
    if mode == "generate":
        where.append("mode = 'generate'")
    elif mode == "edit":
        where.append("mode != '' and mode != 'generate'")
    elif mode:
        where.append("mode = ?")
        params.append(mode)
    for column, value in (
        ("status", status),
        ("prompt_mode", prompt_mode),
        ("size", size),
        ("quality", quality),
        ("orientation", orientation),
        ("backend", backend),
        ("provider", provider),
    ):
        if value:
            where.append(f"{column} = ?")
            params.append(value)
    if ratio:
        if ratio == ratio_other_value:
            where.append("ratio = ''")
        else:
            where.append("ratio = ?")
            params.append(ratio)
    if archived is True:
        where.append("archived_at != ''")
    elif archived is False:
        where.append("archived_at = ''")
    if favorite is True:
        where.append(
            """
            exists (
                select 1
                from history_org.task_favorites f
                where f.task_id = task_index.task_id
            )
            """.strip()
        )
    for tag_id in tag_ids:
        where.append(
            """
            exists (
                select 1
                from history_org.task_tags tt
                where tt.task_id = task_index.task_id
                  and tt.tag_id = ?
            )
            """.strip()
        )
        params.append(tag_id)
    if untagged:
        where.append(
            """
            not exists (
                select 1
                from history_org.task_tags tt
                where tt.task_id = task_index.task_id
            )
            """.strip()
        )

    cursor_values = _decode_history_cursor(cursor)
    if cursor_values is not None:
        cursor_created_at, cursor_task_id = cursor_values
        if page_direction == "previous":
            if sort_order == "oldest":
                where.append(
                    "(created_at < ? or "
                    "(created_at = ? and task_id < ?))"
                )
            else:
                where.append(
                    "(created_at > ? or "
                    "(created_at = ? and task_id > ?))"
                )
        elif sort_order == "oldest":
            where.append(
                "(created_at > ? or "
                "(created_at = ? and task_id > ?))"
            )
        else:
            where.append(
                "(created_at < ? or "
                "(created_at = ? and task_id < ?))"
            )
        params.extend(
            [cursor_created_at, cursor_created_at, cursor_task_id]
        )

    clean_query = q.strip()
    if clean_query:
        search_like = f"%{clean_query}%"
        if use_fts:
            where.append(
                "(task_id like ? or search_text like ? or "
                "task_id in ("
                "select task_id from task_index_fts "
                "where task_index_fts match ?"
                "))"
            )
            params.extend(
                [search_like, search_like, _fts_query(clean_query)]
            )
        else:
            where.append("(task_id like ? or search_text like ?)")
            params.extend([search_like, search_like])
    return where, params


def _history_order_clause(
    sort_order: str,
    page_direction: str,
) -> str:
    if page_direction == "previous":
        if sort_order == "oldest":
            return "order by created_at desc, task_id desc limit ?"
        return "order by created_at asc, task_id asc limit ?"
    if sort_order == "oldest":
        return "order by created_at asc, task_id asc limit ?"
    return "order by created_at desc, task_id desc limit ?"


def _history_sql(
    select_sql: str,
    where: list[str],
    order_clause: str,
) -> str:
    sql = select_sql
    if where:
        sql += " where " + " and ".join(where)
    return f"{sql} {order_clause}"


def _organization_payloads(
    connection: sqlite3.Connection,
    task_ids: list[str],
) -> dict[str, dict[str, Any]]:
    payloads: dict[str, dict[str, Any]] = {
        task_id: {"favorite": False, "tags": []}
        for task_id in task_ids
    }
    if not task_ids:
        return payloads
    placeholders = ", ".join("?" for _ in task_ids)
    favorite_rows = connection.execute(
        f"""
        select task_id
        from history_org.task_favorites
        where task_id in ({placeholders})
        """,
        tuple(task_ids),
    ).fetchall()
    for row in favorite_rows:
        payloads[str(row["task_id"])]["favorite"] = True
    tag_rows = connection.execute(
        f"""
        select tt.task_id, t.tag_id, t.name
        from history_org.task_tags tt
        join history_org.tags t on t.tag_id = tt.tag_id
        where tt.task_id in ({placeholders})
        order by t.name_key, t.tag_id
        """,
        tuple(task_ids),
    ).fetchall()
    for row in tag_rows:
        payloads[str(row["task_id"])]["tags"].append(
            {
                "tag_id": str(row["tag_id"]),
                "name": str(row["name"]),
            }
        )
    return payloads
