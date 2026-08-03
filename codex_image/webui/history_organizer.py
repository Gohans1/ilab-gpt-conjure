from __future__ import annotations

from contextlib import closing
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
import sqlite3
from typing import Callable, Iterable
import unicodedata
import uuid


HISTORY_ORGANIZER_SCHEMA_VERSION = 1


class HistoryOrganizerError(ValueError):
    pass


class InvalidTagNameError(HistoryOrganizerError):
    pass


class TagNameConflictError(HistoryOrganizerError):
    pass


class TagNotFoundError(HistoryOrganizerError):
    pass


@dataclass(frozen=True)
class HistoryTag:
    tag_id: str
    name: str


@dataclass(frozen=True)
class HistoryOrganization:
    favorite: bool
    tags: tuple[HistoryTag, ...]


def normalize_tag_name(value: object) -> tuple[str, str]:
    name = str(value or "").strip()
    if not 1 <= len(name) <= 40:
        raise InvalidTagNameError("Tag name must contain 1 to 40 characters")
    name_key = unicodedata.normalize("NFKC", name).casefold()
    return name, name_key


def _unique_nonempty(values: Iterable[object]) -> list[str]:
    return list(
        dict.fromkeys(
            text
            for value in values
            if (text := str(value or "").strip())
        )
    )


def _utc_now() -> str:
    return datetime.now(UTC).isoformat()


class HistoryOrganizer:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("pragma foreign_keys = on")
        connection.execute("pragma journal_mode = wal")
        connection.execute("pragma busy_timeout = 5000")
        return connection

    def _init_schema(self) -> None:
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    """
                    create table if not exists history_meta (
                        key text primary key,
                        value text not null
                    )
                    """
                )
                connection.execute(
                    """
                    create table if not exists tags (
                        tag_id text primary key,
                        name text not null,
                        name_key text not null unique,
                        created_at text not null,
                        updated_at text not null
                    )
                    """
                )
                connection.execute(
                    """
                    create table if not exists task_tags (
                        task_id text not null,
                        tag_id text not null,
                        assigned_at text not null,
                        primary key (task_id, tag_id),
                        foreign key (tag_id) references tags(tag_id)
                            on delete cascade
                    )
                    """
                )
                connection.execute(
                    """
                    create table if not exists task_favorites (
                        task_id text primary key,
                        favorite_at text not null
                    )
                    """
                )
                connection.execute(
                    """
                    create index if not exists task_tags_by_tag
                    on task_tags(tag_id, task_id)
                    """
                )
                connection.execute(
                    """
                    create index if not exists task_favorites_by_time
                    on task_favorites(favorite_at desc, task_id)
                    """
                )
                connection.execute(
                    """
                    insert into history_meta(key, value)
                    values('schema_version', ?)
                    on conflict(key) do nothing
                    """,
                    (str(HISTORY_ORGANIZER_SCHEMA_VERSION),),
                )

    def list_tags(self) -> list[HistoryTag]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                """
                select tag_id, name
                from tags
                order by name_key, tag_id
                """
            ).fetchall()
        return [
            HistoryTag(tag_id=str(row["tag_id"]), name=str(row["name"]))
            for row in rows
        ]

    def create_tag(self, value: object) -> HistoryTag:
        name, name_key = normalize_tag_name(value)
        tag_id = uuid.uuid4().hex
        now = _utc_now()
        with closing(self._connect()) as connection:
            try:
                with connection:
                    connection.execute(
                        """
                        insert into tags(
                            tag_id, name, name_key, created_at, updated_at
                        )
                        values(?, ?, ?, ?, ?)
                        """,
                        (tag_id, name, name_key, now, now),
                    )
            except sqlite3.IntegrityError as exc:
                raise TagNameConflictError("A tag with this name already exists") from exc
        return HistoryTag(tag_id=tag_id, name=name)

    def rename_tag(self, tag_id: object, value: object) -> HistoryTag:
        clean_tag_id = str(tag_id or "").strip()
        name, name_key = normalize_tag_name(value)
        with closing(self._connect()) as connection:
            try:
                with connection:
                    existing = connection.execute(
                        "select 1 from tags where tag_id = ?",
                        (clean_tag_id,),
                    ).fetchone()
                    if existing is None:
                        raise TagNotFoundError("Tag not found")
                    connection.execute(
                        """
                        update tags
                        set name = ?, name_key = ?, updated_at = ?
                        where tag_id = ?
                        """,
                        (name, name_key, _utc_now(), clean_tag_id),
                    )
            except sqlite3.IntegrityError as exc:
                raise TagNameConflictError("A tag with this name already exists") from exc
        return HistoryTag(tag_id=clean_tag_id, name=name)

    def delete_tag(self, tag_id: object) -> int:
        clean_tag_id = str(tag_id or "").strip()
        with closing(self._connect()) as connection:
            with connection:
                existing = connection.execute(
                    "select 1 from tags where tag_id = ?",
                    (clean_tag_id,),
                ).fetchone()
                if existing is None:
                    raise TagNotFoundError("Tag not found")
                affected = int(
                    connection.execute(
                        "select count(*) from task_tags where tag_id = ?",
                        (clean_tag_id,),
                    ).fetchone()[0]
                )
                connection.execute(
                    "delete from tags where tag_id = ?",
                    (clean_tag_id,),
                )
        return affected

    def organize(
        self,
        task_ids: Iterable[object],
        *,
        favorite: bool | None = None,
        add_tag_ids: Iterable[object] = (),
        remove_tag_ids: Iterable[object] = (),
    ) -> dict[str, HistoryOrganization]:
        clean_task_ids = _unique_nonempty(task_ids)
        clean_add_ids = _unique_nonempty(add_tag_ids)
        clean_remove_ids = _unique_nonempty(remove_tag_ids)
        overlap = set(clean_add_ids) & set(clean_remove_ids)
        if overlap:
            raise ValueError("A tag cannot be added and removed in one request")
        if favorite is not None and not isinstance(favorite, bool):
            raise ValueError("favorite must be true, false, or omitted")
        if not clean_task_ids:
            return {}

        now = _utc_now()
        with closing(self._connect()) as connection:
            with connection:
                self._require_tags(
                    connection,
                    [*clean_add_ids, *clean_remove_ids],
                )
                if favorite is True:
                    connection.executemany(
                        """
                        insert into task_favorites(task_id, favorite_at)
                        values(?, ?)
                        on conflict(task_id) do update
                        set favorite_at = excluded.favorite_at
                        """,
                        ((task_id, now) for task_id in clean_task_ids),
                    )
                elif favorite is False:
                    connection.executemany(
                        "delete from task_favorites where task_id = ?",
                        ((task_id,) for task_id in clean_task_ids),
                    )
                if clean_add_ids:
                    connection.executemany(
                        """
                        insert or ignore into task_tags(
                            task_id, tag_id, assigned_at
                        )
                        values(?, ?, ?)
                        """,
                        (
                            (task_id, tag_id, now)
                            for task_id in clean_task_ids
                            for tag_id in clean_add_ids
                        ),
                    )
                if clean_remove_ids:
                    connection.executemany(
                        """
                        delete from task_tags
                        where task_id = ? and tag_id = ?
                        """,
                        (
                            (task_id, tag_id)
                            for task_id in clean_task_ids
                            for tag_id in clean_remove_ids
                        ),
                    )
                result = self._organizations_for_tasks(
                    connection,
                    clean_task_ids,
                )
        return result

    def restore_task_organization(
        self,
        task_id: object,
        favorite: bool,
        tag_names: Iterable[object],
        *,
        failure_injector: Callable[[str], None] | None = None,
    ) -> HistoryOrganization:
        clean_task_id = str(task_id or "").strip()
        if not clean_task_id:
            raise ValueError("task_id is required")
        if not isinstance(favorite, bool):
            raise ValueError("favorite must be true or false")
        normalized: dict[str, str] = {}
        for value in tag_names:
            name, name_key = normalize_tag_name(value)
            normalized.setdefault(name_key, name)
        now = _utc_now()
        with closing(self._connect()) as connection:
            with connection:
                existing = connection.execute(
                    """
                    select 1 from task_favorites where task_id = ?
                    union all
                    select 1 from task_tags where task_id = ?
                    limit 1
                    """,
                    (clean_task_id, clean_task_id),
                ).fetchone()
                if existing is not None:
                    raise HistoryOrganizerError("task_organization_conflict")
                tag_ids: list[str] = []
                for name_key, name in normalized.items():
                    row = connection.execute(
                        "select tag_id from tags where name_key = ?",
                        (name_key,),
                    ).fetchone()
                    if row is None:
                        # Imported archive IDs are deliberately ignored. Local IDs
                        # are always freshly allocated for missing normalized names.
                        tag_id = uuid.uuid4().hex
                        connection.execute(
                            """
                            insert into tags(tag_id, name, name_key, created_at, updated_at)
                            values(?, ?, ?, ?, ?)
                            """,
                            (tag_id, name, name_key, now, now),
                        )
                    else:
                        tag_id = str(row["tag_id"])
                    tag_ids.append(tag_id)
                if favorite:
                    connection.execute(
                        """
                        insert into task_favorites(task_id, favorite_at)
                        values(?, ?)
                        on conflict(task_id) do nothing
                        """,
                        (clean_task_id, now),
                    )
                for tag_id in tag_ids:
                    connection.execute(
                        """
                        insert or ignore into task_tags(task_id, tag_id, assigned_at)
                        values(?, ?, ?)
                        """,
                        (clean_task_id, tag_id, now),
                    )
                if failure_injector is not None:
                    failure_injector("after_organizer_write")
                return self._organizations_for_tasks(connection, [clean_task_id])[clean_task_id]

    def has_task_state(self, task_id: object) -> bool:
        clean_task_id = str(task_id or "").strip()
        if not clean_task_id:
            return False
        with closing(self._connect()) as connection:
            return connection.execute(
                """
                select 1 from task_favorites where task_id = ?
                union all
                select 1 from task_tags where task_id = ?
                limit 1
                """,
                (clean_task_id, clean_task_id),
            ).fetchone() is not None

    def organizations_for_tasks(
        self,
        task_ids: Iterable[object],
    ) -> dict[str, HistoryOrganization]:
        clean_task_ids = _unique_nonempty(task_ids)
        if not clean_task_ids:
            return {}
        with closing(self._connect()) as connection:
            return self._organizations_for_tasks(connection, clean_task_ids)

    def delete_task_state(self, task_id: object) -> None:
        clean_task_id = str(task_id or "").strip()
        if not clean_task_id:
            return
        with closing(self._connect()) as connection:
            with connection:
                connection.execute(
                    "delete from task_tags where task_id = ?",
                    (clean_task_id,),
                )
                connection.execute(
                    "delete from task_favorites where task_id = ?",
                    (clean_task_id,),
                )

    def delete_orphan_tags(self, tag_ids: Iterable[object]) -> None:
        clean_ids = _unique_nonempty(tag_ids)
        if not clean_ids:
            return
        with closing(self._connect()) as connection:
            with connection:
                for tag_id in clean_ids:
                    connection.execute(
                        """
                        delete from tags
                        where tag_id = ?
                          and not exists (
                              select 1 from task_tags where task_tags.tag_id = tags.tag_id
                          )
                        """,
                        (tag_id,),
                    )

    def _require_tags(
        self,
        connection: sqlite3.Connection,
        tag_ids: list[str],
    ) -> None:
        if not tag_ids:
            return
        placeholders = ", ".join("?" for _ in tag_ids)
        rows = connection.execute(
            f"select tag_id from tags where tag_id in ({placeholders})",
            tuple(tag_ids),
        ).fetchall()
        existing = {str(row["tag_id"]) for row in rows}
        missing = [tag_id for tag_id in tag_ids if tag_id not in existing]
        if missing:
            raise TagNotFoundError(
                "Tag not found: " + ", ".join(missing)
            )

    def _organizations_for_tasks(
        self,
        connection: sqlite3.Connection,
        task_ids: list[str],
    ) -> dict[str, HistoryOrganization]:
        organizations: dict[str, dict[str, object]] = {
            task_id: {"favorite": False, "tags": []}
            for task_id in task_ids
        }
        placeholders = ", ".join("?" for _ in task_ids)
        favorite_rows = connection.execute(
            f"""
            select task_id
            from task_favorites
            where task_id in ({placeholders})
            """,
            tuple(task_ids),
        ).fetchall()
        for row in favorite_rows:
            organizations[str(row["task_id"])]["favorite"] = True

        tag_rows = connection.execute(
            f"""
            select tt.task_id, t.tag_id, t.name
            from task_tags tt
            join tags t on t.tag_id = tt.tag_id
            where tt.task_id in ({placeholders})
            order by t.name_key, t.tag_id
            """,
            tuple(task_ids),
        ).fetchall()
        for row in tag_rows:
            task_id = str(row["task_id"])
            tags = organizations[task_id]["tags"]
            if isinstance(tags, list):
                tags.append(
                    HistoryTag(
                        tag_id=str(row["tag_id"]),
                        name=str(row["name"]),
                    )
                )

        return {
            task_id: HistoryOrganization(
                favorite=bool(values["favorite"]),
                tags=tuple(values["tags"])
                if isinstance(values["tags"], list)
                else (),
            )
            for task_id, values in organizations.items()
        }
