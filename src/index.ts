import * as pupeteer from "puppeteer";
import axios from "axios";
import * as fs from "fs";

interface HouseData {
  url: string | null;
  maintenanceFee: string | null;
  areaOfTHeHouse: string | null;
  numberOfDorms: string | null;
  numberOfBathrooms: string | null;
  rentPrice: string | null;
  description: string | null;
}

interface DataStore {
  [groupId: string]: {
    searchLinks: string[];
    alreadySeenHouses: { [houseUrl: string]: boolean };
    maxPrice: number;
  };
}

require("dotenv").config();

const API_KEY = process.env.TELEGRAM_API_KEY;
const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE ?? "1");
const UF_VALUE = parseInt(process.env.UF_VALUE ?? "38000");

const readDataStore = (): DataStore => {
  const data = fs.readFileSync("dataStore.json", "utf8");
  return JSON.parse(data);
};

const initBrowser = async () => {
  const browser = await pupeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  return browser;
};

const updateAlreadySeenHouses = (chatId: string, housesData: HouseData[]) => {
  const dataStore = readDataStore();
  const chatConfig = dataStore[chatId];
  for (const house of housesData) {
    chatConfig.alreadySeenHouses[house.url ?? ""] = true;
  }
  fs.writeFileSync("dataStore.json", JSON.stringify(dataStore));
};

const formatMessage = (dataMessage: HouseData[]) => {
  return dataMessage
    .map(
      (a) =>
        ` 🏠 ${a.description}
        \n 🛏️ ${a.numberOfDorms}
        \n 🚽 ${a.numberOfBathrooms} 
        \n 📏 ${a.areaOfTHeHouse} 
        \n 💰 ${parseInt(a.rentPrice ?? "").toLocaleString("es-CL", { style: "currency", currency: "CLP" })} 
        \n 📰 (gc) ${a.maintenanceFee}
        \n 🔗 ${a.url}`,
    )
    .join("\n\n");
};

const sendMessageToTelegram = async (
  chatId: string,
  dataMessage: HouseData[],
) => {
  if (dataMessage.length === 0) {
    console.log("No data to send");
    return;
  }
  const url = `https://api.telegram.org/bot${API_KEY}/sendMessage`;
  const data = {
    chat_id: chatId,
    text: formatMessage(dataMessage),
  };
  await axios.post(url, data);
};

const retrieveSpecs = async (
  housePage: pupeteer.Page,
): Promise<{
  numberOfBathrooms: string | null;
  areaOfTheHouse: string | null;
  numberOfDorms: string | null;
  maintenanceFee: string | null;
}> => {
  const specs = await housePage.$$(
    ".ui-pdp-color--BLACK.ui-pdp-size--SMALL.ui-pdp-family--REGULAR.ui-pdp-label",
  );
  const rawMaintenaceFee =
    (await housePage
      .$(
        ".ui-pdp-color--GRAY.ui-pdp-size--XSMALL.ui-pdp-family--REGULAR.ui-pdp-maintenance-fee-ltr",
      )
      .then((a) => a?.evaluate((a) => a.textContent))) ?? "";

  const regexMaintenanceFee = rawMaintenaceFee.match(/\$\s*([0-9.]+)/);

  const maintenanceFee = regexMaintenanceFee ? regexMaintenanceFee[1] : null;

  const areaOfTheHouse = await specs?.[0]?.evaluate((a) => a.textContent);
  const numberOfDorms = await specs?.[1]?.evaluate((a) => a.textContent);
  const numberOfBathrooms = await specs?.[2]?.evaluate((a) => a.textContent);

  return {
    numberOfBathrooms,
    areaOfTheHouse,
    numberOfDorms,
    maintenanceFee,
  };
};

const convertIntoClp = (rawPrice: string, unitPrice: string) => {
  const price = rawPrice.replace(/\./g, "");
  return unitPrice === "UF" ? parseInt(price) * UF_VALUE : parseInt(price);
};

const retrieveHouseCardInfo = async (
  browser: pupeteer.Browser,
  houseCard: pupeteer.ElementHandle,
  alreadySeenHouses: { [houseUrl: string]: boolean },
): Promise<HouseData | null> => {
  try {
    const rawUrl =
      (await houseCard.$("a").then((a) => a?.evaluate((a) => a.href))) ?? "";
    const url = rawUrl.split("#")[0];
    const isHouseAlreadySeen = alreadySeenHouses[url ?? ""];
    console.log(url, isHouseAlreadySeen);
    if (!url || isHouseAlreadySeen) {
      console.log("Unable to retrieve house url or house already seen");
      return null;
    }
    const housePage = await browser.newPage();
    await housePage.goto(url);

    const price = await housePage
      .$(".andes-money-amount__fraction")
      .then((a) => a?.evaluate((a) => a.textContent));

    const unitPrice =
      (await housePage
        .$(".andes-money-amount__currency-symbol")
        .then((a) => a?.evaluate((a) => a.textContent))) ?? "";

    const description = await housePage
      .$(".ui-pdp-title")
      .then((a) => a?.evaluate((a) => a.textContent));

    const { numberOfBathrooms, areaOfTheHouse, numberOfDorms, maintenanceFee } =
      await retrieveSpecs(housePage);

    const priceInClp = convertIntoClp(price ?? "0", unitPrice);

    await housePage.close();

    return {
      url,
      areaOfTHeHouse: areaOfTheHouse ? areaOfTheHouse : null,
      numberOfDorms: numberOfDorms ? numberOfDorms : null,
      numberOfBathrooms,
      rentPrice: price ? `${priceInClp}` : null,
      description: description ? description : null,
      maintenanceFee,
    };
  } catch (e) {
    console.log("Error while retrieving house data", e);
    return null;
  }
};

const retrieveHousesDataFromFilterLink = async (
  browser: pupeteer.Browser,
  url: string,
  alreadySeenHouses: { [houseUrl: string]: boolean },
  searchConfig: DataStore["groupId"],
) => {
  const page = await browser.newPage();
  await page.goto(url);
  const housesData: HouseData[] = [];

  //we only get the first page because paja
  const allHouseCards = await page.$$(".andes-card");
  for (const houseCard of allHouseCards) {
    const houseData = await retrieveHouseCardInfo(
      browser,
      houseCard,
      alreadySeenHouses,
    );
    if (!houseData) continue;
    housesData.push(houseData);
  }
  await page.close();
  return housesData.filter(
    (house) =>
      parseInt(house.rentPrice ?? "0") + parseInt(house.maintenanceFee ?? "0") <
      searchConfig.maxPrice,
  );
};

const chunkArray = (array: any[], chunkSize: number) => {
  const chunkedArray = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunkedArray.push(array.slice(i, i + chunkSize));
  }
  return chunkedArray;
};

const processSearchHousesByChat = async (
  chatId: string,
  searchConfig: DataStore["groupId"],
) => {
  const seachLinks = searchConfig.searchLinks;
  const alreadySeenHouses = searchConfig.alreadySeenHouses;

  const browser = await initBrowser();
  const allHousesLinkData: HouseData[] = [];

  for (const houseLink of seachLinks) {
    const housesFromLink = await retrieveHousesDataFromFilterLink(
      browser,
      houseLink,
      alreadySeenHouses,
      searchConfig,
    );
    allHousesLinkData.push(...housesFromLink);
  }

  const chunkedData = chunkArray(allHousesLinkData, CHUNK_SIZE);

  for (const chunk of chunkedData) {
    await sendMessageToTelegram(chatId, chunk);
  }

  await browser.close();
  updateAlreadySeenHouses(chatId, allHousesLinkData);
};

const main = async () => {
  const dataStore = readDataStore();
  for (const chatid in dataStore) {
    await processSearchHousesByChat(chatid, dataStore[chatid]);
  }
};

main();
