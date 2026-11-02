# Castle Fight — прототип 1 на 1

Node.js + WebSocket. Сервер авторитарный (вся симуляция на сервере, 10 тиков/с), клиент — canvas.
Баланс: `data.json` (правится без изменения логики).

## Локально
    npm install
    npm start        # http://localhost:3000

## Render
1. Залить папку в GitHub-репозиторий (без node_modules).
2. Render → New → Web Service (или Blueprint, есть `render.yaml`), Build: `npm install`, Start: `npm start`.
3. Открыть URL, нажать «Создать комнату», отправить другу ссылку/код.

На бесплатном тарифе Render засыпает без трафика — первое открытие может занять ~50 с.
