#!/usr/bin/env python3

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "assets" / "help"
WIDTH = 1600
MIN_HEIGHT = 2400
HEADER_TOP = 80
HEADER_HEIGHT = 284
CONTENT_TOP = 430
SECTION_GAP = 42
BOTTOM_PADDING = 110
FOOTER_BLOCK_HEIGHT = 150


def load_font(name: str, size: int):
    candidates = [
        f"/usr/share/fonts/truetype/dejavu/{name}.ttf",
        f"/usr/share/fonts/{name}.ttf",
    ]
    for candidate in candidates:
        path = Path(candidate)
        if path.exists():
            return ImageFont.truetype(str(path), size=size)
    return ImageFont.load_default()


TITLE_FONT = load_font("DejaVuSans-Bold", 78)
SUBTITLE_FONT = load_font("DejaVuSans", 34)
SECTION_FONT = load_font("DejaVuSans-Bold", 42)
BODY_FONT = load_font("DejaVuSans", 30)
COMMAND_FONT = load_font("DejaVuSansMono", 28)
FOOTER_FONT = load_font("DejaVuSans", 24)
PAGE_BADGE_FONT = load_font("DejaVuSans-Bold", 30)

COMMAND_LINE_HEIGHT = 34
BODY_LINE_HEIGHT = 35
BODY_LINE_SPACING = 8

HELP_CARD_COPY = {
    "rus": {
        "outputs": [
            OUTPUT_DIR / "telegram-help-card-rus-1.png",
            OUTPUT_DIR / "telegram-help-card-rus-2.png",
        ],
        "page_subtitles": [
            "Лёгкая и практичная ежедневная шпаргалка по командам сервера.",
            "Продолжение: suffixes, runtime controls и глобальные defaults.",
        ],
        "footer": (
            "Один топик = одна сессия. Обычный /wait делает локальное одноразовое окно, "
            "а /wait global включает постоянный глобальный режим."
        ),
        "page_splits": [
            [0, 1, 2],
            [3, 4],
        ],
        "sections": [
            (
                "Session",
                [
                    ("/help", "Эта шпаргалка."),
                    ("/guide", "PDF-гайдбук для новичка из General."),
                    ("/new [cwd=...|path=...] [title]", "Создать новую рабочую тему."),
                    ("/status", "Статус сессии, модели и текущего контекста."),
                    ("/global", "Pin-friendly меню глобальных настроек в General."),
                    ("/menu", "Pin-friendly меню локальных настроек в текущем топике."),
                    ("/auto | /auto status | /auto off", "Omni auto mode для этого топика."),
                    ("/omni [вопрос]", "Спросить Omni; во время /auto можно и просто вопросом текстом."),
                    ("/language", "Показать или сменить язык интерфейса."),
                ],
            ),
            (
                "Prompt Flow",
                [
                    ("plain text", "Обычный prompt в текущей теме."),
                    ("/wait 60  |  wait 600", "Локальное одноразовое окно для следующего prompt."),
                    ("/wait global 60", "Постоянное global окно для всех тем чата."),
                    ("files / photos during /wait", "Можно докидывать части и вложения."),
                    ("Все | Всё | All", "Сразу отправить накопленное как один prompt."),
                    ("/wait off", "Отменить локальное окно и очистить его буфер."),
                    ("/wait global off", "Выключить global окно и очистить его буфер."),
                    ("/interrupt", "Остановить активный run."),
                ],
            ),
            (
                "Artifacts",
                [
                    ("/diff", "Снять diff текущего workspace."),
                    ("/compact", "Пересобрать brief из exchange log."),
                    ("/purge", "Сбросить local session state."),
                ],
            ),
            (
                "Prompt Suffix",
                [
                    ("/suffix <text>", "Локальный suffix для текущего топика."),
                    ("/suffix global <text>", "Глобальный suffix для всех тем."),
                    ("/suffix topic on|off", "Включить или отключить routing suffixes."),
                    ("/suffix help", "Отдельная памятка по suffix."),
                ],
            ),
            (
                "Runtime",
                [
                    ("/model [list|clear|<slug>]", "Модель Spike для этого топика."),
                    ("/model global <slug>", "Глобальный default модели Spike."),
                    ("/reasoning [list|clear|<level>]", "Ризонинг Spike для этого топика."),
                    ("/reasoning global <level>", "Глобальный default ризонинга Spike."),
                    ("/omni_model [list|clear|<slug>]", "Модель Omni для этого топика."),
                    ("/omni_model global <slug>", "Глобальный default модели Omni."),
                    ("/omni_reasoning [list|clear|<level>]", "Ризонинг Omni для этого топика."),
                    ("/omni_reasoning global <level>", "Глобальный default ризонинга Omni."),
                ],
            ),
        ],
    },
    "eng": {
        "outputs": [
            OUTPUT_DIR / "telegram-help-card-eng-1.png",
            OUTPUT_DIR / "telegram-help-card-eng-2.png",
        ],
        "page_subtitles": [
            "Light, fast, and practical daily reference for the server commands.",
            "Continuation: suffixes, runtime controls, and global defaults.",
        ],
        "footer": (
            "One topic = one session. Plain /wait creates a local one-shot window, "
            "while /wait global enables the persistent global mode."
        ),
        "page_splits": [
            [0, 1, 2],
            [3, 4],
        ],
        "sections": [
            (
                "Session",
                [
                    ("/help", "This cheat sheet."),
                    ("/guide", "Beginner PDF guidebook from General."),
                    ("/new [cwd=...|path=...] [title]", "Create a new work topic."),
                    ("/status", "Session, model, and current context status."),
                    ("/global", "Pin-friendly global settings menu in General."),
                    ("/menu", "Pin-friendly local settings menu in this topic."),
                    ("/auto | /auto status | /auto off", "Omni auto mode for this topic."),
                    ("/omni [question]", "Ask Omni; during /auto a plain question also works."),
                    ("/language", "Show or change the UI language."),
                ],
            ),
            (
                "Prompt Flow",
                [
                    ("plain text", "Normal prompt in the current topic."),
                    ("/wait 60  |  wait 600", "Local one-shot window for the next prompt."),
                    ("/wait global 60", "Persistent global window across chat topics."),
                    ("files / photos during /wait", "You can add more parts and attachments."),
                    ("All | Все | Всё", "Flush the collected prompt immediately."),
                    ("/wait off", "Cancel the local window and clear its buffer."),
                    ("/wait global off", "Disable the global window and clear its buffer."),
                    ("/interrupt", "Stop the active run."),
                ],
            ),
            (
                "Artifacts",
                [
                    ("/diff", "Capture the current workspace diff."),
                    ("/compact", "Rebuild the brief from the exchange log."),
                    ("/purge", "Reset local session state."),
                ],
            ),
            (
                "Prompt Suffix",
                [
                    ("/suffix <text>", "Topic-local suffix."),
                    ("/suffix global <text>", "Global suffix for all topics."),
                    ("/suffix topic on|off", "Enable or disable routing suffixes."),
                    ("/suffix help", "Separate suffix cheat sheet."),
                ],
            ),
            (
                "Runtime",
                [
                    ("/model [list|clear|<slug>]", "Spike model for this topic."),
                    ("/model global <slug>", "Global default Spike model."),
                    ("/reasoning [list|clear|<level>]", "Spike reasoning for this topic."),
                    ("/reasoning global <level>", "Global default Spike reasoning."),
                    ("/omni_model [list|clear|<slug>]", "Omni model for this topic."),
                    ("/omni_model global <slug>", "Global default Omni model."),
                    ("/omni_reasoning [list|clear|<level>]", "Omni reasoning for this topic."),
                    ("/omni_reasoning global <level>", "Global default Omni reasoning."),
                ],
            ),
        ],
    },
}


def make_background(height):
    image = Image.new("RGBA", (WIDTH, height), "#FFF8D9")
    draw = ImageDraw.Draw(image, "RGBA")
    for y in range(height):
        ratio = y / max(height - 1, 1)
        r = int(255 * (1 - ratio) + 255 * ratio)
        g = int(248 * (1 - ratio) + 221 * ratio)
        b = int(217 * (1 - ratio) + 170 * ratio)
        draw.line([(0, y), (WIDTH, y)], fill=(r, g, b, 255))

    draw.ellipse((WIDTH - 420, 80, WIDTH - 90, 410), fill=(255, 214, 102, 215))
    draw.ellipse((WIDTH - 390, 110, WIDTH - 120, 380), fill=(255, 236, 164, 190))

    clouds = [
        (110, 120, 320, 210),
        (250, 90, 470, 215),
        (980, 150, 1190, 240),
        (1120, 115, 1360, 250),
    ]
    for left, top, right, bottom in clouds:
        draw.rounded_rectangle(
            (left, top, right, bottom),
            radius=60,
            fill=(255, 255, 255, 145),
        )

    footer_clouds = [
        (180, height - 420, 420, height - 300),
        (320, height - 460, 580, height - 320),
    ]
    for left, top, right, bottom in footer_clouds:
        draw.rounded_rectangle(
            (left, top, right, bottom),
            radius=60,
            fill=(255, 214, 134, 255),
        )
    return image


def wrap_lines(draw, text, font, max_width):
    words = text.split()
    lines = []
    current = []
    for word in words:
        candidate = " ".join(current + [word]).strip()
        width = draw.textbbox((0, 0), candidate, font=font)[2]
        if current and width > max_width:
            lines.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(" ".join(current))
    return lines


def draw_wrapped_lines(draw, lines, x, y, font, fill, line_height, line_spacing):
    current_y = y
    for line in lines:
        draw.text((x, current_y), line, font=font, fill=fill)
        current_y += line_height + line_spacing
    return current_y


def draw_wrapped(draw, text, font, fill, box, line_spacing=10):
    x0, y0, x1, _ = box
    lines = wrap_lines(draw, text, font, x1 - x0)
    line_height = draw.textbbox((0, 0), "Ag", font=font)[3]
    return draw_wrapped_lines(draw, lines, x0, y0, font, fill, line_height, line_spacing)


def build_section_layout(draw, items):
    description_width = WIDTH - 110 - 52 - (110 + 78)
    row_gap = 28
    section_header_height = 118
    row_specs = []

    for command, description in items:
        description_lines = wrap_lines(draw, description, BODY_FONT, description_width)
        description_height = (
            len(description_lines) * BODY_LINE_HEIGHT
            + max(len(description_lines) - 1, 0) * BODY_LINE_SPACING
        )
        row_height = COMMAND_LINE_HEIGHT + 16 + description_height + 22
        row_specs.append((command, description_lines, row_height))

    content_height = sum(spec[2] for spec in row_specs) + row_gap * max(len(row_specs) - 1, 0)
    card_height = section_header_height + content_height + 46
    return row_specs, card_height


def draw_section(draw, top, title, items, accent):
    left = 110
    right = WIDTH - 110
    title_box_left = left + 30
    title_box_top = top + 26
    title_width = draw.textbbox((0, 0), title, font=SECTION_FONT)[2]
    title_box_right = title_box_left + max(title_width + 44, 190)
    command_x = left + 78
    description_x = left + 78
    row_gap = 28
    row_specs, card_height = build_section_layout(draw, items)

    draw.rounded_rectangle(
        (left + 10, top + 12, right + 10, top + card_height + 12),
        radius=44,
        fill=(36, 47, 78, 255),
    )
    draw.rounded_rectangle(
        (left, top, right, top + card_height),
        radius=42,
        fill=(255, 249, 238, 255),
        outline=(255, 225, 150, 255),
        width=3,
    )
    draw.rounded_rectangle(
        (title_box_left, title_box_top, title_box_right, top + 84),
        radius=28,
        fill=accent,
    )
    draw.text((left + 58, top + 34), title, font=SECTION_FONT, fill="#7A4300")

    current_y = top + 112
    for command, description_lines, row_height in row_specs:
        draw.rounded_rectangle(
            (left + 46, current_y + 8, left + 58, current_y + 20),
            radius=6,
            fill="#F29A38",
        )
        draw.text((command_x, current_y - 4), command, font=COMMAND_FONT, fill="#A25C00")
        draw_wrapped_lines(
            draw,
            description_lines,
            description_x,
            current_y + 46,
            BODY_FONT,
            "#5E513F",
            BODY_LINE_HEIGHT,
            BODY_LINE_SPACING,
        )
        current_y += row_height + row_gap

    return card_height


def compute_card_height(copy, sections, include_footer):
    probe = Image.new("RGBA", (WIDTH, 32), "#FFF8D9")
    draw = ImageDraw.Draw(probe, "RGBA")
    top = CONTENT_TOP
    for title, items in sections:
        _, card_height = build_section_layout(draw, items)
        top += card_height + SECTION_GAP

    if include_footer:
        top += FOOTER_BLOCK_HEIGHT + 48

    return max(MIN_HEIGHT, top + BOTTOM_PADDING)


def draw_header(draw, subtitle, page_index, page_count):
    draw.rounded_rectangle(
        (90, HEADER_TOP, WIDTH - 90, HEADER_TOP + HEADER_HEIGHT),
        radius=56,
        fill=(255, 251, 241, 255),
        outline=(255, 224, 147, 255),
        width=4,
    )
    draw.text((125, 118), "SEVERUS", font=TITLE_FONT, fill="#9C4B00")
    draw.text(
        (128, 208),
        "Telegram Gateway Help",
        font=TITLE_FONT,
        fill="#5F3400",
    )
    draw.text(
        (132, 308),
        subtitle,
        font=SUBTITLE_FONT,
        fill="#8B693B",
    )

    badge_text = f"{page_index}/{page_count}"
    badge_width = draw.textbbox((0, 0), badge_text, font=PAGE_BADGE_FONT)[2]
    badge_left = WIDTH - 220
    badge_top = 116
    draw.rounded_rectangle(
        (badge_left, badge_top, badge_left + max(110, badge_width + 34), badge_top + 56),
        radius=24,
        fill=(255, 233, 176, 255),
    )
    draw.text(
        (badge_left + 18, badge_top + 11),
        badge_text,
        font=PAGE_BADGE_FONT,
        fill="#7A4300",
    )


def render_card(copy, sections, page_index, page_count, include_footer):
    height = compute_card_height(copy, sections, include_footer)
    image = make_background(height)
    draw = ImageDraw.Draw(image, "RGBA")

    draw_header(draw, copy["page_subtitles"][page_index - 1], page_index, page_count)

    accents = [
        (255, 233, 176, 255),
        (255, 216, 146, 255),
        (255, 227, 157, 255),
        (255, 238, 188, 255),
        (255, 229, 171, 255),
    ]
    top = CONTENT_TOP
    for index, (title, items) in enumerate(sections):
        card_height = draw_section(draw, top, title, items, accents[index % len(accents)])
        top += card_height + SECTION_GAP

    if include_footer:
        footer_top = height - 180
        draw.rounded_rectangle(
            (100, footer_top, WIDTH - 100, height - 82),
            radius=34,
            fill=(255, 246, 219, 255),
        )
        draw_wrapped(
            draw,
            copy["footer"],
            FOOTER_FONT,
            "#6A4A1F",
            (130, footer_top + 26, WIDTH - 130, height - 102),
            line_spacing=4,
        )

    return image


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for language, copy in HELP_CARD_COPY.items():
        page_count = len(copy["page_splits"])
        for page_index, section_indexes in enumerate(copy["page_splits"], start=1):
            sections = [copy["sections"][index] for index in section_indexes]
            image = render_card(
                copy,
                sections,
                page_index,
                page_count,
                include_footer=(page_index == page_count),
            )
            output_path = copy["outputs"][page_index - 1]
            image.save(output_path, format="PNG")
            print(output_path)

    legacy_output = OUTPUT_DIR / "telegram-help-card.png"
    first_rus_page = render_card(
        HELP_CARD_COPY["rus"],
        [HELP_CARD_COPY["rus"]["sections"][index] for index in HELP_CARD_COPY["rus"]["page_splits"][0]],
        1,
        len(HELP_CARD_COPY["rus"]["page_splits"]),
        include_footer=False,
    )
    first_rus_page.save(legacy_output, format="PNG")
    print(legacy_output)


if __name__ == "__main__":
    main()
