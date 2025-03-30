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

const TOTAL_SUPPLY = ethers.BigNumber.from(process.env.TOTAL_SUPPLY);

const getWallets = async () => {
    return JSON.parse(fs.readFileSync('seedFile.json', 'utf8'));
};


const endDegradation = parseFloat(process.env.END_DEGRADATION)
const tokenAbi = JSON.parse(fs.readFileSync('tokenAbi.json', 'utf8'));
const parlayContractJson = JSON.parse(fs.readFileSync('ParlayCoreSimple.json', 'utf8'));
const parlayContractAbi = parlayContractJson.abi;



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
            console.log('ETH Price', `Updated ETH Price from Moralis: ${ethers.utils.formatUnits(ethPrice, 18)}`);
            lastPriceUpdateTime = now;
        } catch (e) {
            console.log('Error', e.message);
        }
    }
};

const getTokenBalance = async (address) => {
    const contract = new ethers.Contract(tokenAddress, tokenAbi, wsProvider);
    return await contract.balanceOf(address);
};

const getTokenPrice = async (signer) => {
    const tokensForBondingCurveBalance = await parlayContract.connect(signer).tokens(tokenAddress).then(result => result.tokensForBondingCurveBalance);
    const tokensForUniswapBalance = await parlayContract.connect(signer).tokens(tokenAddress).then(result => result.tokensForUniswapBalance);
    
    const etherBalance = await parlayContract.connect(signer).tokens(tokenAddress).then(result => result.etherBalance);
    const totalTokens = tokensForUniswapBalance.add(tokensForBondingCurveBalance);
    const amountOut = ethers.BigNumber.from("1000000000000000000");
    console.log("tokensForBondingCurveBalance",tokensForBondingCurveBalance);
    console.log("tokensForUniswapBalance",tokensForUniswapBalance);
    console.log("etherBalance",etherBalance);
    console.log("ethPrice", ethPrice);
    
    tokenPrice = (amountOut.mul(etherBalance)).div(totalTokens.sub(amountOut)).mul(ethPrice).div(ethers.BigNumber.from("1000000000000000000"));
    console.log("TokenPrice",(ethers.utils.formatUnits(tokenPrice, 18)));
}

const getMarketCap = async () => {
    if(!tokenPrice || tokenPrice == null) tokenPrice = ethers.BigNumber.from(0);
    marketCap = tokenPrice.mul(TOTAL_SUPPLY).div(ethers.constants.WeiPerEther);
    console.log('Market Cap', `Market Cap: ${ethers.utils.formatUnits(marketCap, 0)}`); // Remove decimals for market cap
    return marketCap;
};

const getNonce = async (signer) => {
    return await signer.getTransactionCount();
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

const sellAllTokens = async () => {
    const wallets = await getWallets();

    for(const wallet of wallets){
        const { publicKey, privateKey, balance, lastBuyTime: walletLastBuyTime, lastSellTime: walletLastSellTime, nonce } = wallet;
        console.log('Processing', `Processing wallet: ${publicKey}`);
        const signer = new ethers.Wallet(privateKey, mevBlockerProvider);

        await getTokenPrice(signer);
        await getMarketCap();
        const tokenBalance = await getTokenBalance(publicKey);

        console.log("tokenBalance",ethers.utils.formatUnits(tokenBalance,18));

        const tokensToSell = tokenBalance.mul(ethers.BigNumber.from(Math.floor(endDegradation * 100))).div(100);

        console.log("tokensToSell",tokensToSell);
        

        const contract = new ethers.Contract(tokenAddress, tokenAbi, signer);
        const allowance = await contract.allowance(publicKey, parlayContractAddress);
        if (allowance.lt(tokensToSell)) {
            const tx = await contract.approve(parlayContractAddress, ethers.constants.MaxUint256);
            const receipt = await tx.wait();
            if (receipt.status !== 1) {
                console.log('Sell', `Approval failed for wallet: ${publicKey}`);
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
                console.log('Sell', `Sell completed. Wallet: ${publicKey}`);
                
                // Update prices after a successful buy
                await getTokenPrice();  
                await getMarketCap();
            }
        } catch (error) {
            continue;
        }
    }
}
getEthPriceFromApi().then(() => sellAllTokens());
