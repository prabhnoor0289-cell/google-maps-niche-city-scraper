FROM apify/actor-node-playwright-chrome:20

COPY package*.json ./

RUN npm install --omit=dev --omit=optional

COPY . ./

CMD npm start --silent
