require('dotenv').config();
const ethers = require('ethers');
const fs = require('fs');

const NUM_WALLETS = parseInt(process.env.NUM_WALLETS);

let wsProviderUrl;

if(process.env.CHAIN = "eth"){  
    wsProviderUrl = process.env.ETH_WS_PROVIDER_URL;
} else if(process.env.CHAIN = "base"){
    wsProviderUrl = process.env.BASE_WS_PROVIDER_URL;
} else if(process.env.CHAIN = "blast") {
    wsProviderUrl = process.env.BLAST_WS_PROVIDER_URL;
}

const generateNewWallets = (numWallets) => {
    const wallets = [];
    for (let i = 0; i < numWallets; i++) {
        const wallet = ethers.Wallet.createRandom();
        wallets.push({
            publicKey: wallet.address,
            privateKey: wallet.privateKey,
            mnemonic: wallet.mnemonic.phrase,
            balance: "0",
            volumeGenerated: "",
            lastBuyTime: null,
            lastSellTime: null
        });
    }
    return wallets;
};

const loadSeedFile = () => {
    const filePath = 'seedFile.json';
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } else {
        throw new Error('Seed file not found.');
    }
};

const saveSeedFile = (seedData) => {
    const filePath = 'seedFile.json';
    const filePath2 = 'addresses.json';
    if (fs.existsSync(filePath)) {
        const backupFileName = `seedFile_${process.env.TICKER}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        fs.renameSync(filePath, backupFileName);
        console.log(`Backed up existing seed file to ${backupFileName}`);
    }
    const addresses = seedData.map(wallet => wallet.publicKey);
    
    fs.writeFileSync(filePath, JSON.stringify(seedData, null, 2), 'utf8');
    fs.writeFileSync(filePath2, JSON.stringify(addresses, null, 2), 'utf8');
    console.log('New seed file saved.');
};

const waitForEth = async (wallet, provider) => {
    console.log(`Waiting for ETH to arrive in the wallet: ${wallet.publicKey}`);
    while (true) {
        const balance = await provider.getBalance(wallet.publicKey);
        if (balance.gt(ethers.utils.parseEther("0.01"))) { // Assuming a minimum of 0.1 ETH to start dispersing
            console.log(`ETH received: ${ethers.utils.formatEther(balance)} ETH`);
            return balance;
        }
        await new Promise(resolve => setTimeout(resolve, 30000)); // Check every 30 seconds
    }
};

const disperseEth = async (initialBalance, wallets, provider) => {
    const totalWallets = wallets.length;
    const signer = new ethers.Wallet(wallets[0].privateKey, provider);
    const gasPrice = await provider.getGasPrice();
    const estimatedGasLimit = ethers.BigNumber.from(21000); // Standard gas limit for a simple ETH transfer

    // Calculate the total gas cost for sending ETH to each wallet
    const totalGasCost = gasPrice.mul(estimatedGasLimit).mul(totalWallets - 1);
    const netBalance = initialBalance.sub(totalGasCost);

    if (netBalance.lt(ethers.utils.parseEther("0.001"))) {
        console.log('Not enough ETH to disperse after accounting for gas fees.');
        return;
    }

    const amountPerWallet = netBalance.div(totalWallets);

    for (let i = 1; i < totalWallets; i++) {
        const tx = await signer.sendTransaction({
            to: wallets[i].publicKey,
            value: amountPerWallet,
            gasLimit: estimatedGasLimit,
            gasPrice: gasPrice
        });
        await tx.wait();
        wallets[i].balance = ethers.utils.formatEther(amountPerWallet);
        console.log(`Dispersed ${ethers.utils.formatEther(amountPerWallet)} ETH to wallet: ${wallets[i].publicKey}`);
    }

    wallets[0].balance = ethers.utils.formatEther(netBalance.sub(amountPerWallet.mul(totalWallets - 1)));
    saveSeedFile(wallets);
    console.log('ETH dispersed and seed file updated.');
};

const initSeedFile = async () => {
    const provider = new ethers.providers.WebSocketProvider(wsProviderUrl);

    if (process.env.CREATE === "Y") {
        const wallets = generateNewWallets(NUM_WALLETS);
        saveSeedFile(wallets);
        console.log(`Seed file created with ${NUM_WALLETS} wallets and saved.`);
        const initialBalance = await waitForEth(wallets[0], provider);
        await disperseEth(initialBalance, wallets, provider);
    } else if (process.env.DISPERSE === "Y") {
        try {
            const wallets = loadSeedFile();
            console.log(`Loaded ${wallets.length} wallets from seed file.`);
            const initialBalance = await waitForEth(wallets[0], provider);
            await disperseEth(initialBalance, wallets, provider);
        } catch (error) {
            console.error(error.message);
        }
    } else {
        console.log('Seed file already created and disperse not required. Exiting...');
    }
   
};

initSeedFile();
