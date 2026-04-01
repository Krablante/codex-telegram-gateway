#!/usr/bin/env python3

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIR = ROOT / "assets" / "help"
WIDTH = 1600
HEIGHT = 3700


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

COMMAND_LINE_HEIGHT = 34
BODY_LINE_HEIGHT = 35
BODY_LINE_SPACING = 8

HELP_CARD_COPY = {
    "rus": {
        "output": OUTPUT_DIR / "telegram-help-card-rus.png",
        "subtitle": "Лёгкая и практичная ежедневная шпаргалка по командам сервера.",
        "footer": (
            "Один топик = одна сессия. Используй /wait, когда одного сообщения мало, "
            "и заверши набор отдельным `Все`."
        ),
        "sections": [
            (
                "Session",
                [
                    ("/help", "Эта шпаргалка."),
                    ("/new [cwd=...|path=...] [title]", "Создать новую рабочую тему."),
                    ("/status", "Статус сессии, модели и текущего контекста."),
                    ("/language", "Показать или сменить язык интерфейса."),
                ],
            ),
            (
                "Prompt Flow",
                [
                    ("plain text", "Обычный prompt в текущей теме."),
                    ("/wait 60  |  wait 600", "Глобальное окно ручного сбора."),
                    ("files / photos during /wait", "Можно докидывать части и вложения."),
                    ("Все", "Сразу отправить накопленное как один prompt."),
                    ("/wait off", "Выключить окно и очистить буфер."),
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
        ],
    },
    "eng": {
        "output": OUTPUT_DIR / "telegram-help-card-eng.png",
        "subtitle": "Light, fast, and practical daily reference for the server commands.",
        "footer": (
            "One topic = one session. Use /wait when one message is not enough, "
            "and finish the collected bundle with `All`."
        ),
        "sections": [
            (
                "Session",
                [
                    ("/help", "This cheat sheet."),
                    ("/new [cwd=...|path=...] [title]", "Create a new work topic."),
                    ("/status", "Session, model, and current context status."),
                    ("/language", "Show or change the UI language."),
                ],
            ),
            (
                "Prompt Flow",
                [
                    ("plain text", "Normal prompt in the current topic."),
                    ("/wait 60  |  wait 600", "Global manual collection window."),
                    ("files / photos during /wait", "You can add more parts and attachments."),
                    ("All", "Flush the collected prompt immediately."),
                    ("/wait off", "Disable the window and clear the buffer."),
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
        ],
    },
}


def make_background():
    image = Image.new("RGBA", (WIDTH, HEIGHT), "#FFF8D9")
    draw = ImageDraw.Draw(image, "RGBA")
    for y in range(HEIGHT):
        ratio = y / max(HEIGHT - 1, 1)
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
        (180, HEIGHT - 420, 420, HEIGHT - 300),
        (320, HEIGHT - 460, 580, HEIGHT - 320),
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


def draw_section(draw, top, title, items, accent):
    left = 110
    right = WIDTH - 110
    title_box_left = left + 30
    title_box_top = top + 26
    title_width = draw.textbbox((0, 0), title, font=SECTION_FONT)[2]
    title_box_right = title_box_left + max(title_width + 44, 190)
    command_x = left + 78
    description_x = left + 78
    description_width = right - 52 - description_x
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


def render_card(copy):
    image = make_background()
    draw = ImageDraw.Draw(image, "RGBA")

    draw.rounded_rectangle(
        (90, 80, WIDTH - 90, 364),
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
        copy["subtitle"],
        font=SUBTITLE_FONT,
        fill="#8B693B",
    )

    accents = [
        (255, 233, 176, 255),
        (255, 216, 146, 255),
        (255, 227, 157, 255),
        (255, 238, 188, 255),
    ]
    top = 430
    for index, (title, items) in enumerate(copy["sections"]):
        card_height = draw_section(draw, top, title, items, accents[index % len(accents)])
        top += card_height + 42

    draw.rounded_rectangle(
        (100, HEIGHT - 180, WIDTH - 100, HEIGHT - 82),
        radius=34,
        fill=(255, 246, 219, 255),
    )
    draw_wrapped(
        draw,
        copy["footer"],
        FOOTER_FONT,
        "#6A4A1F",
        (130, HEIGHT - 154, WIDTH - 130, HEIGHT - 102),
        line_spacing=4,
    )

    return image


def main():
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for language, copy in HELP_CARD_COPY.items():
      image = render_card(copy)
      image.save(copy["output"], format="PNG")
      print(copy["output"])

    legacy_output = OUTPUT_DIR / "telegram-help-card.png"
    render_card(HELP_CARD_COPY["rus"]).save(legacy_output, format="PNG")
    print(legacy_output)


if __name__ == "__main__":
    main()
