const ethers = require('ethers');
const fs = require('fs');
const Table = require('cli-table3');
const Moralis = require('moralis').default;
require('dotenv').config();


let tokenAddress;
let wethAddress;
let moralisChainId;
let wsProviderUrl;
let mevBlockerProviderUrl;
let parlayContractAddress;

moralisChainId=process.env.MORALIS_CHAINID;
wethAddress=process.env.WETH_ADDRESS;
if(process.env.CHAIN == "eth"){
    tokenAddress=process.env.ETH_TOKEN_ADDRESS;
    wsProviderUrl = process.env.ETH_WS_PROVIDER_URL;
    mevBlockerProviderUrl= process.env.ETH_MEV_BLOCKER_PROVIDER_URL;
    parlayContractAddress= process.env.ETH_PARLAYCONTRACT_ADDRESS;
} else if(process.env.CHAIN == "base") {
    tokenAddress=process.env.BASE_TOKEN_ADDRESS;
    wsProviderUrl = process.env.BASE_WS_PROVIDER_URL;
    mevBlockerProviderUrl= process.env.BASE_MEV_BLOCKER_PROVIDER_URL;
    parlayContractAddress= process.env.BASE_PARLAYCONTRACT_ADDRESS;

}


const degradation = parseFloat(process.env.DEGRADATION);
const decimals = parseInt(process.env.DECIMALS);
const MIN_ETH_SPEND = parseFloat(process.env.MIN_ETH_SPEND);
const MAX_ETH_SPEND = parseFloat(process.env.MAX_ETH_SPEND);
const MIN_MARKET_CAP = parseFloat(process.env.MIN_MARKET_CAP);
const MAX_MARKET_CAP = parseFloat(process.env.MAX_MARKET_CAP);
const sellPrice = parseFloat(process.env.SELL_PRICE);
const TOTAL_SUPPLY = ethers.BigNumber.from(process.env.TOTAL_SUPPLY);
const tokenAbi = JSON.parse(fs.readFileSync('tokenAbi.json', 'utf8'));
const parlayContractJson = JSON.parse(fs.readFileSync('ParlayCoreSimple.json', 'utf8'));
const parlayContractAbi = parlayContractJson.abi;

const getWallets = async () => {
    return JSON.parse(fs.readFileSync('seedFile.json', 'utf8'));
};


const wsProvider = new ethers.providers.WebSocketProvider(wsProviderUrl);
const mevBlockerProvider = new ethers.providers.JsonRpcProvider(mevBlockerProviderUrl);
const owner = getWallets().privateKey;



const parlayContract = new ethers.Contract(
    parlayContractAddress,
    parlayContractAbi,
    owner
);

const MORALIS_API_KEY = process.env.MORALIS_KEY; // Replace with your Moralis API key
Moralis.start({ apiKey: MORALIS_API_KEY });

let ethPrice = ethers.BigNumber.from(0);
let tokenPrice = ethers.BigNumber.from(0);
let marketCap = 0;
let lastPriceUpdateTime = 0;
const PRICE_UPDATE_INTERVAL = 60000;
let threeBuys = 0;
let threeSells = 0;
const actionHistory = [];

let blockNow = 0;

const walletTable = new Table({
    head: ['Wallet Address', 'ETH Balance', 'Token Balance', 'Token Value (ETH)', 'Last Buy Time', 'Last Sell Time'],
    colWidths: [42, 20, 20, 20, 20, 20]
});

const marketTable = new Table({
    head: ['Number of Buys', 'ETH Price', 'Market Cap', 'Token Price', 'Market Cap High', 'Market Cap Low'],
    colWidths: [15, 20, 20, 20, 20, 20]
});

const logTable = new Table({
    head: ['Action', 'Message'],
    colWidths: [10, 150]
});
const getEthPriceFromApi = async () => {
    const now = Date.now();
    if (now - lastPriceUpdateTime > PRICE_UPDATE_INTERVAL) {
        try {
            const response = await Moralis.EvmApi.token.getTokenPrice({
                chain: moralisChainId,
                address: wethAddress
            });
            const usdPrice = response.raw.usdPrice.toFixed(18);
            ethPrice = ethers.utils.parseUnits(usdPrice, 18);
            addLog('ETH Price', `Updated ETH Price from Moralis: ${ethers.utils.formatUnits(ethPrice, 18)}`);
            lastPriceUpdateTime = now;
        } catch (e) {
            addLog('Error', e.message);
        }
    }
};

const updateTables = async () => {
    walletTable.splice(0, walletTable.length);
    const wallets = await getWallets();
    for (const wallet of wallets) {
        const { publicKey, lastBuyTime, lastSellTime } = wallet;
        const ethBalance = ethers.utils.formatEther(await wsProvider.getBalance(publicKey));
        const tokenBalance = ethers.utils.formatUnits(await getTokenBalance(publicKey), decimals);
        const tokenValueInEth = ethers.utils.formatEther(tokenPrice.mul(await getTokenBalance(publicKey)).div(ethers.constants.WeiPerEther));
        walletTable.push([publicKey, ethBalance, tokenBalance, tokenValueInEth, lastBuyTime ? new Date(lastBuyTime).toLocaleString() : 'N/A', lastSellTime ? new Date(lastSellTime).toLocaleString() : 'N/A']);
    }
    const marketCap = await getMarketCap();
    const { minPrice, maxPrice } = getMinMaxPriceLevels();
    marketTable.splice(0, marketTable.length);
    marketTable.push([
        threeBuys,
        ethers.utils.formatUnits(ethPrice, 18),
        ethers.utils.formatUnits(marketCap, 0),
        ethers.utils.formatUnits(tokenPrice, 18),
        ethers.utils.formatUnits(maxPrice, 18),
        ethers.utils.formatUnits(minPrice, 18)
    ]);

    logTable.splice(0, logTable.length);
    for (const log of actionHistory.slice(-5)) {
        logTable.push(log);
    }

    // console.clear();
    console.log(walletTable.toString());
    console.log(marketTable.toString());
    console.log(logTable.toString());
};

const addLog = (action, message) => {
    actionHistory.push([action, message]);
    if (actionHistory.length > 5) {
        actionHistory.shift();
    }
};



const updateVolume = async (publicKey, volume, lastBuyTime = null, lastSellTime = null) => {
    const walletsData = JSON.parse(fs.readFileSync('seedFile.json', 'utf8'));
    const walletIndex = walletsData.findIndex(wallet => wallet.publicKey === publicKey);
    if (walletIndex >= 0) {
        walletsData[walletIndex].volumeGenerated += volume;
        if (lastBuyTime) {
            walletsData[walletIndex].lastBuyTime = lastBuyTime;
        }
        if (lastSellTime) {
            walletsData[walletIndex].lastSellTime = lastSellTime;
        } else {
            walletsData[walletIndex].lastSellTime = Date.now();
        }
        fs.writeFileSync('seedFile.json', JSON.stringify(walletsData, null, 2), 'utf8');
    }
};

const updateNonce = async (publicKey, newNonce) => {
    const walletsData = JSON.parse(fs.readFileSync('seedFile.json', 'utf8'));
    const walletIndex = walletsData.findIndex(wallet => wallet.publicKey === publicKey);
    if (walletIndex >= 0) {
        walletsData[walletIndex].nonce = newNonce;
        fs.writeFileSync('seedFile.json', JSON.stringify(walletsData, null, 2), 'utf8');
    }
};

const fetchTokenBalances = async () => {
    const wallets = await getWallets();
    const balances = {};
    for (const wallet of wallets) {
        const { publicKey } = wallet;
        const balance = await getTokenBalance(publicKey);
        balances[publicKey] = balance.toString();
    }
    fs.writeFileSync('tokenBalances.json', JSON.stringify(balances, null, 2), 'utf8');
    addLog('Balances', 'Token balances updated.');
};

const getTokenBalance = async (address) => {
    const contract = new ethers.Contract(tokenAddress, tokenAbi, wsProvider);
    return await contract.balanceOf(address);
};

const getWethBalanceInPair = async () => {
    const wethContract = new ethers.Contract(wethAddress, tokenAbi, wsProvider);
    const wethBalance = await wethContract.balanceOf(pairAddress);
    return wethBalance;
};

const getTokenPrice = async (signer) => {
    const tokensForBondingCurveBalance = await parlayContract.connect(signer).tokens(tokenAddress).then(result => result.tokensForBondingCurveBalance);
    const tokensForUniswapBalance = await parlayContract.connect(signer).tokens(tokenAddress).then(result => result.tokensForUniswapBalance);
    
    const etherBalance = await parlayContract.connect(signer).tokens(tokenAddress).then(result => result.etherBalance);
    const totalTokens = tokensForUniswapBalance.add(tokensForBondingCurveBalance);
    const amountOut = ethers.BigNumber.from("1000000000000000000");
    tokenPrice = (amountOut.mul(etherBalance)).div(totalTokens.sub(amountOut)).mul(ethPrice).div(ethers.BigNumber.from("1000000000000000000"));
}
 
const updateTokenPrice = async () => {
    const now = Date.now();
    if (now - lastPriceUpdateTime > PRICE_UPDATE_INTERVAL) {
        try {
            addLog('Token Price', `Updated Token Price: ${(ethers.utils.formatUnits(tokenPrice, 18))}`);
            lastPriceUpdateTime = now;
        } catch (e) {
            tokenPrice = ethers.BigNumber.from(0);
            addLog('Error', e.message);
        }
    }
};


const getMarketCap = async () => {
    if(!tokenPrice || tokenPrice == null) tokenPrice = ethers.BigNumber.from(0);
    marketCap = tokenPrice.mul(TOTAL_SUPPLY).div(ethers.constants.WeiPerEther);
    addLog('Market Cap', `Market Cap: ${ethers.utils.formatUnits(marketCap, 0)}`); // Remove decimals for market cap
    return marketCap;
};

const getMinMaxPriceLevels = () => {
    const minPrice = ethers.utils.parseUnits((MIN_MARKET_CAP / process.env.TOTAL_SUPPLY).toFixed(18), 18);
    const maxPrice = ethers.utils.parseUnits((MAX_MARKET_CAP / process.env.TOTAL_SUPPLY).toFixed(18), 18);
    addLog('Price Levels', `Min Price: ${ethers.utils.formatUnits(minPrice, 18)}, Max Price: ${ethers.utils.formatUnits(maxPrice, 18)}`);
    return { minPrice, maxPrice };
};

const getNonce = async (signer) => {
    return await signer.getTransactionCount();
};

const marketMake = async () => {
    await fetchTokenBalances();
    const wallets = await getWallets();
    await updateTokenPrice();
    for (const wallet of wallets) {
        const { publicKey, privateKey, balance, lastBuyTime: walletLastBuyTime, lastSellTime: walletLastSellTime, nonce } = wallet;
        addLog('Processing', `Processing wallet: ${publicKey}`);
        const signer = new ethers.Wallet(privateKey, mevBlockerProvider);
        await getMarketCap();
        await getTokenPrice(signer);
        
        const getRandomEthAmount = () => {
            const amount = (Math.random() * (MAX_ETH_SPEND - MIN_ETH_SPEND) + MIN_ETH_SPEND).toFixed(10);
            addLog('Random Amount', `Random ETH amount to spend: ${amount}`);
            return amount;
        };
        
        const buy = async () => {
            let amountToSpend = ethers.utils.parseEther(getRandomEthAmount());
            const balance = await signer.getBalance();
            
            
            if (wallet.lastBuyTime && (Date.now() - wallet.lastBuyTime < 300000)) {
                addLog('Buy', 'Waiting for next Buy window.');
                return ethers.BigNumber.from(0);
            }
            if (ethers.utils.formatUnits(marketCap, 0) >= sellPrice) {
                addLog('Buy', `Price ${ethers.utils.formatUnits(marketCap, 18)} out of bounds. ${sellPrice} Skipping buy.`);
                return ethers.BigNumber.from(0);
            }
            if (wallet.lastBuyTime && (Date.now() - wallet.lastBuyTime >= 300000)) {
                addLog('Buy', 'keep buying.');
                threeBuys = 0;
            }
            
            
            try {
                const estimatedGas = await parlayContract.connect(signer).estimateGas.swapExactETHForTokens(
                    tokenAddress,
                    0,
                    { value: amountToSpend }
                );

                const gasPrice = await signer.getGasPrice();
                
                const totalCost = amountToSpend.add(gasPrice.mul(estimatedGas));
                
                if (balance.lt(totalCost)) {
                    addLog('Buy', `Insufficient funds. Wallet balance: ${ethers.utils.formatEther(balance)}, Required: ${ethers.utils.formatEther(totalCost)}`);
                    return ethers.BigNumber.from(0);
                }
                
                const nonce = await getNonce(signer);

                const tx = await parlayContract.connect(signer).swapExactETHForTokens(
                    tokenAddress,
                    0,
                    { value: amountToSpend, gasLimit: estimatedGas.mul(3), nonce: nonce }
                );
                
                const receipt = await tx.wait();
                if (receipt.status === 1) {
                    const logs = receipt.logs.filter(log => log.address === tokenAddress);
                    const tokensReceived = logs.reduce((acc, log) => acc.add(ethers.BigNumber.from(log.data)), ethers.BigNumber.from(0));
                    await updateVolume(publicKey, parseFloat(ethers.utils.formatEther(amountToSpend)), Date.now());
                    addLog('Buy', `Bought tokens: ${tokensReceived.toString()} with ${amountToSpend.toString()} ETH`);
                    threeBuys++;
                    addLog('Buy', `Buy completed. Wallet: ${publicKey}, ETH: ${ethers.utils.formatUnits(amountToSpend, 18)}, Token Price: ${ethers.utils.formatUnits(tokenPrice, 18)}, Market Cap: ${ethers.utils.formatUnits(marketCap, 0)}`); 
                    
                    // Update prices after a successful buy
                    await getTokenPrice(signer);  
                    await getMarketCap();
                    return tokensReceived;
                }
            } catch (error) {
                addLog('Error', `Error during buy transaction: ${error.message}`);
                return ethers.BigNumber.from(0);
            }

            return ethers.BigNumber.from(0);
        };

        if (threeBuys < 3) {
            await buy();
            addLog('Buy Count', `Number of buys: ${threeBuys}`);
        }

        const sell = async (tokensToSell) => {

            if (wallet.lastSellTime && (Date.now() - wallet.lastSellTime < 300000)) {
                addLog('Sell', 'Waiting for next sell window.');
                return ethers.BigNumber.from(0);
            }
            if (ethers.utils.formatUnits(marketCap, 0) <= sellPrice) {
                addLog('Sell', `Price ${ethers.utils.formatUnits(marketCap, 18)} out of bounds. ${sellPrice} Skipping sell.`);
                return ethers.BigNumber.from(0);
            }
            if (wallet.lastSellTime && (Date.now() - wallet.lastSellTime >= 300000)) {
                addLog('Buy', 'keep selling.');
                threeSells = 0;
            }

            const contract = new ethers.Contract(tokenAddress, tokenAbi, signer);
            const allowance = await contract.allowance(publicKey, parlayContractAddress);
            if (allowance.lt(tokensToSell)) {
                const tx = await contract.approve(parlayContractAddress, ethers.constants.MaxUint256);
                const receipt = await tx.wait();
                if (receipt.status !== 1) {
                    addLog('Sell', `Approval failed for wallet: ${publicKey}`);
                    return ethers.BigNumber.from(0);
                }
            }

            wallet.lastSellTime = Date.now();

            try {
                const estimatedGas = await parlayContract.connect(signer).estimateGas.swapExactTokensForETH(
                    tokenAddress,
                    tokensToSell,
                    0,
                );

                const nonce = await getNonce(signer);

                const tx = await parlayContract.connect(signer).swapExactTokensForETH(
                    tokenAddress,
                    tokensToSell,
                    0,
                    { gasLimit: estimatedGas.mul(2), nonce: nonce }
                );

                const receipt = await tx.wait();
                
                if (receipt.status === 1) {
                    const ethReceived = receipt.logs
                        .filter(log => log.address === wethAddress)
                        .reduce((acc, log) => acc.add(ethers.BigNumber.from(log.data)), ethers.BigNumber.from(0));
                    await updateVolume(publicKey, parseFloat(ethers.utils.formatEther(ethReceived)), null, Date.now());
                    
                    // Update prices after a successful buy
                    await getTokenPrice(signer);  
                    await getMarketCap();

                    // await updateNonce(publicKey, nonce + 1);
                    addLog('Sell', `Sold tokens: ${tokensToSell.toString()} for ${ethReceived.toString()} ETH`);

                    threeSells++;
                    if (threeSells >= 2) {
                        threeBuys = 0;
                    }

                    addLog('Sell', `Sell completed. Wallet: ${publicKey}, ETH: ${ethers.utils.formatUnits(ethReceived, 18)}, Token Price: ${ethers.utils.formatUnits(tokenPrice, 18)}, Market Cap: ${ethers.utils.formatUnits(marketCap, 0)}`);
                    return ethReceived;
                }
            } catch (error) {
                addLog('Error', `Error during sell transaction: ${error.message}`);
                return ethers.BigNumber.from(0);
            }

            return ethers.BigNumber.from(0);
        };

        const tokenBalance = await getTokenBalance(publicKey);
        const tokensToSell = tokenBalance.mul(ethers.BigNumber.from(Math.floor(degradation * 100))).div(100);
        
        await updateTables();

        if (threeBuys > 2) {
            addLog('Volume Sell Attempt', `Wallet: ${publicKey}, Tokens: ${tokensToSell.toString()}`);
            await sell(tokensToSell);
        } else {
            addLog('Routine Sell Attempt', `Wallet: ${publicKey}, Tokens: ${tokensToSell.toString()}`);
            await sell(tokensToSell);
        }
    }
    await updateTables();
    addLog('Cycle', '--- Cycle complete ---');
};

getEthPriceFromApi();
marketMake();

wsProvider.on('block', async (blockNumber) => {
    addLog('Block', `New block detected: ${blockNumber}`);
    if(blockNow + 2 <= blockNumber) await marketMake();
    blockNow = blockNumber;
});