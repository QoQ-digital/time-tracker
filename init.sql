-- =====================================================================
-- Tetris Time Tracker — initial schema, indexes, and seed data.
-- Loaded by postgres on first container start (docker-entrypoint-initdb.d).
-- Idempotent: safe to re-run against an existing schema.
-- =====================================================================

-- Separate schema for n8n's own tables so app data and n8n metadata don't mix.
CREATE SCHEMA IF NOT EXISTS n8n;

SET search_path TO public;

-- ---------------------------------------------------------------------
-- 1. categories
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_categories (
    id          BIGSERIAL PRIMARY KEY,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 2. examples used to ground the AI classifier
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_category_examples (
    id                       BIGSERIAL PRIMARY KEY,
    category_code            TEXT NOT NULL REFERENCES time_categories(code),
    example_text             TEXT NOT NULL,
    normalized_example_text  TEXT,
    source                   TEXT NOT NULL DEFAULT 'manual',
        -- seed | manual | explicit_user_code | clarification
    usage_count              INTEGER NOT NULL DEFAULT 0,
    is_active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at               TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Prevent duplicate seed examples on re-run.
CREATE UNIQUE INDEX IF NOT EXISTS uq_time_category_examples_code_text
    ON time_category_examples (category_code, example_text);

-- ---------------------------------------------------------------------
-- 3. goals (daily / weekly)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_goals (
    id            BIGSERIAL PRIMARY KEY,
    goal_type     TEXT NOT NULL,        -- daily | weekly
    date_from     DATE NOT NULL,
    date_to       DATE NOT NULL,
    category_code TEXT NOT NULL REFERENCES time_categories(code),
    goal_minutes  INTEGER NOT NULL CHECK (goal_minutes > 0),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (goal_type, date_from, date_to, category_code)
);

-- ---------------------------------------------------------------------
-- 4. message batches (one Telegram message → one batch → 1+ slots)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_message_batches (
    id                  BIGSERIAL PRIMARY KEY,
    telegram_chat_id    TEXT NOT NULL,
    telegram_user_id    TEXT NOT NULL,
    telegram_message_id TEXT,
    raw_text            TEXT NOT NULL,
    batch_date          DATE NOT NULL,
    status              TEXT NOT NULL DEFAULT 'confirmed',
        -- confirmed | pending_clarification | replaced | deleted | ignored
    parent_batch_id     BIGINT REFERENCES time_message_batches(id),
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 5. slots (the actual time entries)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_slots (
    id                     BIGSERIAL PRIMARY KEY,
    batch_id               BIGINT NOT NULL REFERENCES time_message_batches(id),
    slot_date              DATE NOT NULL,
    start_time             TIME,
    end_time               TIME,
    duration_minutes       INTEGER NOT NULL CHECK (duration_minutes > 0),
    activity               TEXT NOT NULL,
    category_code          TEXT REFERENCES time_categories(code),
    category_name          TEXT,
    emotional_mark         TEXT NOT NULL DEFAULT 'N',
    confidence             NUMERIC(5, 4),
    classification_source  TEXT NOT NULL DEFAULT 'ai',
        -- explicit_user_code | ai | clarification | manual_command
    status                 TEXT NOT NULL DEFAULT 'confirmed',
        -- confirmed | pending_clarification | replaced | deleted | ignored
    needs_clarification    BOOLEAN NOT NULL DEFAULT FALSE,
    clarification_question TEXT,
    suggested_categories   JSONB,
    created_at             TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 6. pending clarifications (open questions to the user)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_pending_clarifications (
    id                    BIGSERIAL PRIMARY KEY,
    batch_id              BIGINT NOT NULL REFERENCES time_message_batches(id),
    slot_id               BIGINT REFERENCES time_slots(id),
    telegram_chat_id      TEXT NOT NULL,
    telegram_user_id      TEXT NOT NULL,
    original_text         TEXT NOT NULL,
    question_text         TEXT NOT NULL,
    suggested_categories  JSONB,
    status                TEXT NOT NULL DEFAULT 'pending',
        -- pending | resolved | cancelled | replaced
    created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
    resolved_at           TIMESTAMP
);

-- ---------------------------------------------------------------------
-- 7. last dashboard message id per chat (so we can delete + resend)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_dashboard_messages (
    id                  BIGSERIAL PRIMARY KEY,
    telegram_chat_id    TEXT NOT NULL,
    telegram_message_id TEXT NOT NULL,
    dashboard_scope     TEXT NOT NULL DEFAULT 'main',
    created_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (telegram_chat_id, dashboard_scope)
);

-- ---------------------------------------------------------------------
-- 8. per-user UI settings
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_user_settings (
    id                       BIGSERIAL PRIMARY KEY,
    telegram_user_id         TEXT NOT NULL UNIQUE,
    dashboard_mode           TEXT NOT NULL DEFAULT 'compact',  -- compact | full
    show_weekly              BOOLEAN NOT NULL DEFAULT TRUE,
    show_daily               BOOLEAN NOT NULL DEFAULT TRUE,
    max_dashboard_categories INTEGER NOT NULL DEFAULT 8,
    created_at               TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMP NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------
-- 9. accumulator (optional; PoC recalculates from slots, but we keep
--    the table so we can move to incremental updates later without a
--    schema migration). See README §"Performance" for the trade-offs.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_category_totals (
    id            BIGSERIAL PRIMARY KEY,
    period_type   TEXT NOT NULL,          -- daily | weekly
    period_start  DATE NOT NULL,
    period_end    DATE NOT NULL,
    category_code TEXT NOT NULL REFERENCES time_categories(code),
    total_minutes INTEGER NOT NULL DEFAULT 0,
    updated_at    TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (period_type, period_start, period_end, category_code)
);

-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_time_slots_date_status
    ON time_slots (slot_date, status);

CREATE INDEX IF NOT EXISTS idx_time_slots_category_status
    ON time_slots (category_code, status);

CREATE INDEX IF NOT EXISTS idx_time_slots_batch
    ON time_slots (batch_id);

CREATE INDEX IF NOT EXISTS idx_time_batches_telegram_message
    ON time_message_batches (telegram_chat_id, telegram_message_id);

CREATE INDEX IF NOT EXISTS idx_time_batches_chat_status_date
    ON time_message_batches (telegram_chat_id, status, batch_date DESC);

CREATE INDEX IF NOT EXISTS idx_pending_clarifications_chat_status
    ON time_pending_clarifications (telegram_chat_id, status);

CREATE INDEX IF NOT EXISTS idx_time_goals_active_lookup
    ON time_goals (goal_type, date_from, date_to, category_code)
    WHERE is_active;

-- ---------------------------------------------------------------------
-- Seed: categories
-- ---------------------------------------------------------------------
INSERT INTO time_categories (code, name, description) VALUES
    ('JOB_SEARCH',    'Поиск работы / проекта',     'Интервью, резюме, общение с рекрутерами, поиск вакансий, подготовка к интервью'),
    ('SKILL',         'Обучение / развитие навыков','Техническое обучение, книги, курсы, изучение материалов без привязки к конкретному интервью'),
    ('PROJECT_A',     'Проект A',                   'Работа по первому условному проекту'),
    ('PROJECT_B',     'Проект B',                   'Работа по второму условному проекту'),
    ('AI_AUTOMATION', 'AI-автоматизация',           'Автоматизация процессов, AI-инструменты, n8n, интеграции, боты'),
    ('ADMIN',         'Административные задачи',    'Организационные вопросы, документы, оплаты, настройки, операционные задачи'),
    ('COMMUNICATION', 'Рабочие коммуникации',       'Звонки, переписки и обсуждения по текущим задачам без явной проектной категории'),
    ('FRIENDS',       'Время с друзьями',           'Общение и встречи с друзьями'),
    ('PERSONAL',      'Личное время',               'Личные дела и личное общение без рабочей цели'),
    ('HELP',          'Помощь другим',              'Помощь другим людям с их задачами, если это не основной проект'),
    ('SOCIAL_MEDIA',  'Соцсети / личный бренд',     'Контент, фото, посты, присутствие в соцсетях'),
    ('SPORT',         'Спорт / тело',               'Тренировка, бег, разминка, заминка, восстановление после спорта'),
    ('MORNING',       'Утреннее включение',         'Просыпание, душ, приведение себя в рабочее состояние'),
    ('RITUALS',       'Ритуалы / практики',         'Ритуалы, духовные практики, медитация, молитва'),
    ('SLEEP_PREP',    'Подготовка ко сну',          'Гигиена и действия перед сном'),
    ('FOOD',          'Еда',                        'Еда как отдельная активность'),
    ('TRANSIT',       'Дорога / транзит',           'Дорога без отдельной рабочей или социальной нагрузки'),
    ('HOUSEHOLD',     'Бытовые задачи',             'Магазин, посылки, бытовые вопросы, звонки по бытовым делам'),
    ('TELEGRAM',      'Telegram / переписки',       'Telegram как самостоятельная активность без явной рабочей категории'),
    ('PLANNING',      'Планирование / анализ дня',  'Планирование задач, анализ дня, анализ недели, ведение учёта времени'),
    ('REFLECTION',    'Рефлексия',                  'Отдельные размышления и заметки, которые не являются активностью'),
    ('BUFFER',        'Буфер / переключение',       'Короткие паузы, переключение между задачами, включение в работу'),
    ('DISTRACTION',   'Отвлечения',                 'Нецелевой просмотр контента, серфинг, потеря фокуса')
ON CONFLICT (code) DO NOTHING;

-- ---------------------------------------------------------------------
-- Seed: examples
-- ---------------------------------------------------------------------
INSERT INTO time_category_examples (category_code, example_text, source) VALUES
    ('JOB_SEARCH',    '1300-1400 интервью',                                  'seed'),
    ('JOB_SEARCH',    '40 мин делал резюме',                                 'seed'),
    ('JOB_SEARCH',    '20 мин общался с рекрутером',                         'seed'),
    ('JOB_SEARCH',    '30 мин готовился к интервью',                         'seed'),
    ('SKILL',         '45 мин изучал техническую статью',                    'seed'),
    ('SKILL',         '1 час смотрел обучающий материал',                    'seed'),
    ('PROJECT_A',     '1000-1100 [PROJECT_A] звонок по задаче',              'seed'),
    ('PROJECT_A',     '30 мин писал требования по проекту A',                'seed'),
    ('PROJECT_B',     '45 мин обсуждал задачу по проекту B',                 'seed'),
    ('AI_AUTOMATION', '1 час настраивал n8n workflow',                       'seed'),
    ('AI_AUTOMATION', '30 мин проектировал Telegram bot automation',         'seed'),
    ('ADMIN',         '20 мин решал организационный вопрос',                 'seed'),
    ('ADMIN',         '15 мин настраивал доступы',                           'seed'),
    ('COMMUNICATION', '25 мин рабочий звонок по текущим задачам',            'seed'),
    ('FRIENDS',       '0900-1000 [FRIENDS] разговор с другом',               'seed'),
    ('FRIENDS',       '1 час встреча с друзьями',                            'seed'),
    ('PERSONAL',      '30 мин личный разговор',                              'seed'),
    ('HELP',          '20 мин помогал знакомому с вопросом',                 'seed'),
    ('SOCIAL_MEDIA',  '45 мин готовил контент для соцсетей',                 'seed'),
    ('SPORT',         '1900-2030 тренировка',                                'seed'),
    ('SPORT',         '30 мин бег',                                          'seed'),
    ('MORNING',       '0800-0820 душ, включение в день',                     'seed'),
    ('RITUALS',       '20 мин ритуалы',                                      'seed'),
    ('SLEEP_PREP',    '30 мин подготовка ко сну',                            'seed'),
    ('FOOD',          '15 мин поел',                                         'seed'),
    ('TRANSIT',       '20 мин дорога',                                       'seed'),
    ('HOUSEHOLD',     '30 мин магазин и бытовые дела',                       'seed'),
    ('TELEGRAM',      '20 мин отвечал в Telegram',                           'seed'),
    ('PLANNING',      '30 мин планировал задачи на завтра',                  'seed'),
    ('REFLECTION',    '10 мин записывал мысли и наблюдения',                 'seed'),
    ('BUFFER',        '15 мин переключался между задачами',                  'seed'),
    ('DISTRACTION',   '20 мин смотрел видео без конкретной цели',            'seed')
ON CONFLICT (category_code, example_text) DO NOTHING;
