# Змей — VK Mini Apps

Текстурная змейка на Canvas. Управление: стрелки / WASD / свайпы / кнопки. Пауза: `P` или `Space`.

## Запуск локально

Нужен Node.js.

```bash
npm install
npm run dev
```

Дальше открой адрес, который напишет Vite (обычно `http://localhost:5173`).

## Сборка

```bash
npm run build
npm run preview
```

## Интеграция с ВК

- Подключение VK Bridge уже добавлено в `index.html` (через CDN).
- Шаринг результата реализован best-effort в `vk-bridge.js`:
  - внутри ВК попробует `VKWebAppShare`
  - иначе скопирует текст в буфер обмена

## Файлы

- `index.html` — разметка
- `styles.css` — UI/оформление
- `game.js` — игра (логика + отрисовка + текстуры-паттерны)
- `vk-bridge.js` — безопасная обёртка над VK Bridge

