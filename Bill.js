"use strict";

const Nodeway = require('nodeway');
const sql = require('mssql');
const crypto = require('crypto');
const config = require('./Bill.json');
const util = require('./util.js');

process.on('exit', function(code) {
    sql.close();
    console.log('Exit code:', code);
});

function query() {
    return new sql.Connection(config).connect().then(conn => conn.query.apply(conn, arguments));
}

function fillAcl(userInfo, cb) {
    query`select tld from A_tblopentld where acode=${userInfo.user} and CreateDomain=0`
    .then(tld=>{
        userInfo.acl.CreateDomain = tld.map(t=>t.tld);
        return query`select tld from A_tblopentld where acode=${userInfo.user} and DeleteDomain=0`
    })
    .then(tld=>{
        userInfo.acl.DeleteDomain = tld.map(t=>t.tld);
        return query`select tld from A_tblopentld where acode=${userInfo.user} and RenewDomain=0`
    })
    .then(tld=>{
        userInfo.acl.RenewDomain = tld.map(t=>t.tld);
        return query`select tld from A_tblopentld where acode=${userInfo.user} and TransferDomain=0`
    })
    .then(tld=>{
        userInfo.acl.TransferDomain = tld.map(t=>t.tld);
        return query`select tld from A_tblopentld where acode=${userInfo.user} and RestoreDomain=0`
    })
    .then(tld=>{
        userInfo.acl.RestoreDomain = tld.map(t=>t.tld);
        cb(null, userInfo);
    })
    .catch(cb);
}

function getdomainlen(domain){
    let len = 0;
    let s = domain.substring(0, domain.IndexOf("."));
    for (let i = 0; i < s.Length; i++){
        if (s.charAt(i) <= 0xff) len += 1;
        else len += 2;
    }
    return len;
}

function encrypt(pass){
    let hash = crypto.createHash('md5').update(pass,'utf16le').digest('hex');
    let pwd = hash.split('').map((v,i)=>i%2 != 0? v+'-':v);
    return pwd.join('').toUpperCase().slice(0,-1);
}

class Bill extends Nodeway{
    constructor(uuid){
        super(uuid);
    }
    login(clID, pass, cb){
        let userInfo = {};

        query`select code,flag from sys_user where userid=${clID} and pwd=${encrypt(pass)}`
        .then(ret=>{
            userInfo.user = ret[0].code;
            userInfo.flag = ret[0].flag;
            userInfo.acl = {};
            return query`select distinct b.port from A_tblopentld a left join R_domain b on a.tld=b.tld where a.acode=${userInfo.user}`;
        })
        .then(ports=>{
            userInfo.acl.port = ports.map(p=>p.port);

            if(userInfo.flag != 'S') fillAcl(userInfo, cb);
            else {
                userInfo.acl.CreateDomain = [];
                userInfo.acl.DeleteDomain = [];
                userInfo.acl.RenewDomain = [];
                userInfo.acl.TransferDomain = [];
                userInfo.acl.RestoreDomain = [];
                cb(null, userInfo);
            }
        })
        .catch(cb);
    }
    passwd(clID, pass, cb){
        query`update sys_user set pwd=${encrypt(pass)} where userid=${clID}`
        .then(ret=>cb(null, !ret.length))
        .catch(cb);
    }
    cando(user, op, domain, period, cb){
        if (op == "create" && period < 2) {
            cb(new Error("最少注册两年"));
            return;
        }
        let flag = "0";
        let gprice = 0;  //组价格
        let aprice = 0;  //代理商价格
        let gfee = 0;
        let fee = 0;
        let lenflag = ''; //词性，目前只有“商城”才有值；否则就是空；
        let gcode = '';
        let curtime = util.getFullDate();
        let len = getdomainlen(domain);
        let tld = domain.split('.')[1];

        query`select gcode from A_tblopentld where acode=${acode} and tld=${tld}`
        .then(ret=>{
            if(!ret.length) throw new Error('系统中无此代理商账户或未开通此TLD'); // 用回调函数cb是不行的，因为后面的then还会继续执行。必须用throw抛错误，才能终止后面的then执行！！！
            gcode = ret[0].gcode;
            return query`select lenflag from R_domainlen where tld=${tld} and (minlen is null or minlen<=${len}) and (maxlen is null or maxlen>=${len})`
        })
        .then(ret=>{
            if(ret.length) lenflag = ret[0].lenflag;
            return query`select id  from sys_dictionary where flag=1 and ennm=${optype} and mark='1'`
        })
        .then(ret=>{
            if(ret.length) flag = '1';
            return query`select price from R_tblprice where gid in (select gid from G_tblopentld where gcode=${gcode} and tld=${tld}) and tld=${tld} and (years='' or years=${years}) and lenflag=${lenflag} and optype=${optype} and startdatebj<=${curtime} and (enddatebj is null or enddatebj>${curtime})`
        })
        .then(ret=>{
            if(!ret.length) throw new Error('注册商级别或价格未登记');
            gprice = ret[0].price;
            return query`select price from R_tblprice where gid in (select gid from G_tblopentld where acode=${acode} and tld=${tld}) and tld=${tld} and (years='' or years=${years}) and lenflag=${lenflag} and optype=${optype} and startdatebj<=${curtime} and (enddatebj is null or enddatebj>${curtime})`
        })
        .then(ret=>{
            if(!ret.length) throw new Error('代理商级别或价格未登记');
            aprice = ret[0].price;

            if(op != "autorenew"){
                if(flag == "0"){
                    gfee = gprice * period * (-1);
                    fee = aprice * period * (-1);
                }else{
                    gfee = gprice *  (-1);
                    fee = aprice *  (-1);
                }
            }
            return query`select balance from G_tblgroup where gcode=${gcode} and balance+${gfee}>=0`
        })
        .then(ret=>{
            if(!ret.length) throw new Error('注册商余额不足');
            return query`select balance from G_tblgroup where acode=${acode} and balance+${fee}>=0`
        })
        .then(ret=>{
            if(!ret.length) throw new Error('代理商余额不足');
            cb(null, aprice);
        })
        .catch(cb);
    }
    registry(id, cb) {
        this.cookie = id;
        cb(true);
    }
    done(user, op, domain, appID, registrant, opDate, price, period, exDate, oldID, uniID, cb){
        oldID = this.cookie + '/' + oldID;
        uniID = this.cookie + '/' + uniID;
        // 接着写吧。。。
    }
    getAgent(domain, cb){
        let len = getdomainlen(domain);
        let tld = domain.split('.')[1];
        let WhoisEx = {};

        query`select lenflag from R_domainlen where tld=${tld} and (minlen is null or minlen<=${len}) and (maxlen is null or maxlen>=${len})`
        .then(type=>{
            type.length && (WhoisEx.type = type[0].lenflag);
            return query`select top 1 aname from R_Eppryde where domain=${domain} and optype<>'transferout' order by opdatebj desc`
        })
        .then(name=>{
            name.length && (WhoisEx.name = name[0].aname);
            cb(null, WhoisEx);
        }).catch(err=>{
            cb(err);
            util.mailto("getAgent "+err.message, () => {});
        });
    }
}

module.exports = Bill;
