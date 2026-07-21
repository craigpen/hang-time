#!/usr/bin/env python3
"""
Generate placeholder icons for Hang Time extension
Creates simple icons with HT logo in different sizes
"""

from PIL import Image, ImageDraw, ImageFont
import os

# Create public/icons directory if it doesn't exist
os.makedirs('public/icons', exist_ok=True)

# Define colors for Hang Time brand
# Purple/pink gradient theme
PRIMARY_COLOR = (147, 51, 234)  # Purple
SECONDARY_COLOR = (236, 72, 153)  # Pink
TEXT_COLOR = (255, 255, 255)  # White
BACKGROUND = (30, 27, 34)  # Dark gray

sizes = [16, 48, 128]

for size in sizes:
    # Create a new image with RGBA mode
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Draw a rounded rectangle background
    padding = 2 if size == 16 else 4
    draw.rectangle(
        [(padding, padding), (size - padding, size - padding)],
        fill=PRIMARY_COLOR,
        outline=SECONDARY_COLOR,
        width=1 if size > 16 else 0
    )

    # Add gradient effect by drawing semi-transparent circle
    if size > 16:
        draw.ellipse(
            [(size//4, size//4), (3*size//4, 3*size//4)],
            fill=SECONDARY_COLOR + (100,)
        )

    # Try to add text "HT" for sizes >= 48
    if size >= 48:
        try:
            # Try to use a built-in font, fall back to default
            font_size = size // 2
            font = ImageFont.load_default()
            text = "HT"
            # Get text bbox to center it
            bbox = draw.textbbox((0, 0), text, font=font)
            text_width = bbox[2] - bbox[0]
            text_height = bbox[3] - bbox[1]
            x = (size - text_width) // 2
            y = (size - text_height) // 2
            draw.text((x, y), text, fill=TEXT_COLOR, font=font)
        except:
            # If font rendering fails, just use the colored background
            pass

    # Save the icon
    output_path = f'public/icons/icon{size}.png'
    img.save(output_path, 'PNG')
    print(f'[OK] Created {output_path}')

print('\n[DONE] Icon generation complete!')
print('Icons created at: public/icons/')
