import { HttpClient } from '@angular/common/http';
import { Injectable } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { FCMNG } from 'fcm-ng';
import { Events, Modal, ModalController } from 'ionic-angular';
import { Observable } from 'rxjs';
import { Logger } from '../../providers/logger/logger';

// components
import { NotificationComponent } from '../../components/notification-component/notification-component';

// providers
import { AppProvider } from '../app/app';
import { BwcProvider } from '../bwc/bwc';
import { ConfigProvider } from '../config/config';
import { PlatformProvider } from '../platform/platform';
import { ProfileProvider } from '../profile/profile';

import BWC from 'bitcore-wallet-client';
import * as _ from 'lodash';

@Injectable()
export class PushNotificationsProvider {
  private isIOS: boolean;
  private isAndroid: boolean;
  private usePushNotifications: boolean;
  private _token = null;
  private fcmInterval;
  private notifications = [];
  private currentNotif: Modal;
  private openWalletId;

  constructor(
    public http: HttpClient,
    public profileProvider: ProfileProvider,
    public platformProvider: PlatformProvider,
    public configProvider: ConfigProvider,
    public logger: Logger,
    public appProvider: AppProvider,
    private bwcProvider: BwcProvider,
    private FCMPlugin: FCMNG,
    private events: Events,
    private modalCtrl: ModalController,
    private translate: TranslateService
  ) {
    this.logger.debug('PushNotificationsProvider initialized');
    this.isIOS = this.platformProvider.isIOS;
    this.isAndroid = this.platformProvider.isAndroid;
    this.usePushNotifications = this.platformProvider.isCordova;
  }

  public init(): void {
    if (
      this.platformProvider.isIOS ||
      !this.usePushNotifications ||
      this._token
    )
      return;
    this.configProvider.load().then(() => {
      const config = this.configProvider.get();
      if (!config.pushNotifications.enabled) return;

      this.logger.debug('Starting push notification registration...');

      // Keep in mind the function will return null if the token has not been established yet.
      this.FCMPlugin.getToken().then(token => {
        if (!token) {
          setTimeout(() => {
            this.init();
          }, 5000);
          return;
        }
        this.logger.debug('Get token for push notifications: ' + token);
        this._token = token;
        this.enable();
        this.handlePushNotifications();
        // enabling topics
        if (
          this.appProvider.info.name != 'copay' &&
          config.offersAndPromotions.enabled
        )
          this.subscribeToTopic('offersandpromotions');
        if (
          this.appProvider.info.name != 'copay' &&
          config.productsUpdates.enabled
        )
          this.subscribeToTopic('productsupdates');

        this.fcmInterval = setInterval(() => {
          this.renewSubscription();
        }, 3 * 60 * 1000); // 3 min
      });
    });
  }

  private renewSubscription(): void {
    const opts = {
      showHidden: false
    };
    const wallets = this.profileProvider.getWallets(opts);
    _.forEach(wallets, walletClient => {
      this._unsubscribe(walletClient);
    });
    setTimeout(() => {
      this.updateSubscription(wallets);
    }, 1000);
  }

  public handlePushNotifications(): void {
    if (this.usePushNotifications) {
      this.FCMPlugin.onNotification().subscribe(async data => {
        if (!this._token) return;
        this.logger.debug(
          'New Event Push onNotification: ' + JSON.stringify(data)
        );
        if (data.wasTapped) {
          // Notification was received on device tray and tapped by the user.
          if (data.redir) {
            this.events.publish('IncomingDataRedir', { name: data.redir });
          } else if (
            data.takeover_url &&
            data.takeover_image &&
            data.takeover_sig
          ) {
            if (!this.verifySignature(data)) return;
            this.events.publish('ShowAdvertising', data);
          } else {
            this._openWallet(data);
          }
        } else {
          const wallet = this.findWallet(data.walletId, data.tokenAddress);
          if (!wallet && data.notification_type !== 'NewBlock') return;
          const walletId = wallet ? wallet.credentials.walletId : null;
          this.newBwsEvent(data, walletId);
          this.showInappNotification(data);
        }
      });
    }
  }

  private newBwsEvent(notification, walletId): void {
    let id = walletId;
    if (notification.tokenAddress) {
      id = walletId + '-' + notification.tokenAddress.toLowerCase();
      this.logger.debug(`event for token wallet: ${id}`);
    }
    let eventData = {
      walletId: id,
      notification_type: notification.notification_type,
      notification
    };
    this.events.publish('bwsEvent', eventData);
  }

  public updateSubscription(walletClient): void {
    if (!this._token) {
      this.logger.warn(
        'Push notifications disabled for this device. Nothing to do here.'
      );
      return;
    }
    if (!_.isArray(walletClient)) walletClient = [walletClient];
    walletClient.forEach(w => {
      this._subscribe(w);
    });
  }

  public enable(): void {
    if (!this._token) {
      this.logger.warn(
        'No token available for this device. Cannot set push notifications. Needs registration.'
      );
      return;
    }

    const opts = {
      showHidden: false
    };
    const wallets = this.profileProvider.getWallets(opts);
    _.forEach(wallets, walletClient => {
      this._subscribe(walletClient);
    });
  }

  public disable(): void {
    if (!this._token) {
      this.logger.warn(
        'No token available for this device. Cannot disable push notifications.'
      );
      return;
    }

    // disabling topics
    this.unsubscribeFromTopic('offersandpromotions');
    this.unsubscribeFromTopic('productsupdates');

    const opts = {
      showHidden: true
    };
    const wallets = this.profileProvider.getWallets(opts);
    _.forEach(wallets, walletClient => {
      this._unsubscribe(walletClient);
    });
    this._token = null;

    clearInterval(this.fcmInterval);
  }

  public unsubscribe(walletClient): void {
    if (!this._token) return;
    this._unsubscribe(walletClient);
  }

  public subscribeToTopic(topic: string): void {
    this.FCMPlugin.subscribeToTopic(topic);
  }

  public unsubscribeFromTopic(topic: string): void {
    this.FCMPlugin.unsubscribeFromTopic(topic);
  }

  private _subscribe(walletClient): void {
    const opts = {
      token: this._token,
      platform: this.isIOS ? 'ios' : this.isAndroid ? 'android' : null,
      packageName: this.appProvider.info.packageNameId,
      walletId: walletClient.credentials.walletId
    };
    walletClient.pushNotificationsSubscribe(opts, err => {
      if (err)
        this.logger.error(
          walletClient.name + ': Subscription Push Notifications error. ',
          err.message
        );
      else
        this.logger.debug(
          walletClient.name + ': Subscription Push Notifications success.'
        );
    });
  }

  private _unsubscribe(walletClient): void {
    walletClient.pushNotificationsUnsubscribe(this._token, err => {
      if (err)
        this.logger.error(
          walletClient.name + ': Unsubscription Push Notifications error. ',
          err.message
        );
      else
        this.logger.debug(
          walletClient.name + ': Unsubscription Push Notifications Success.'
        );
    });
  }

  private async _openWallet(data) {
    const walletIdHashed = data.walletId;
    const tokenAddress = data.tokenAddress;
    const multisigContractAddress = data.multisigContractAddress;
    if (!walletIdHashed) return;

    const wallet = this.findWallet(
      walletIdHashed,
      tokenAddress,
      multisigContractAddress
    );

    if (!wallet || this.openWalletId === wallet.credentials.walletId) return;

    this.openWalletId = wallet.credentials.walletId; // avoid opening the same wallet many times

    await Observable.timer(1000).toPromise(); // wait for subscription to OpenWallet event

    this.events.publish('OpenWallet', wallet);
  }

  private findWallet(walletIdHashed, tokenAddress, multisigContractAddress?) {
    let walletIdHash;
    const sjcl = this.bwcProvider.getSJCL();

    const wallets = this.profileProvider.getWallets();
    const wallet = _.find(wallets, w => {
      if (tokenAddress || multisigContractAddress) {
        const walletId = w.credentials.walletId;
        const lastHyphenPosition = walletId.lastIndexOf('-');
        const walletIdWithoutTokenAddress = walletId.substring(
          0,
          lastHyphenPosition
        );
        walletIdHash = sjcl.hash.sha256.hash(walletIdWithoutTokenAddress);
      } else {
        walletIdHash = sjcl.hash.sha256.hash(w.credentials.walletId);
      }
      return _.isEqual(walletIdHashed, sjcl.codec.hex.fromBits(walletIdHash));
    });

    return wallet;
  }

  public clearAllNotifications(): void {
    if (!this._token) return;
    this.FCMPlugin.clearAllNotifications();
  }

  private verifySignature(data): boolean {
    const pubKey = this.appProvider.info.marketingPublicKey;
    if (!pubKey) return false;

    const b = BWC.Bitcore;
    const ECDSA = b.crypto.ECDSA;
    const Hash = b.crypto.Hash;
    const SEP = '::';
    const _takeover_url = data.takeover_url;
    const _takeover_image = data.takeover_image;
    const _takeover_sig = data.takeover_sig;

    const sigObj = b.crypto.Signature.fromString(_takeover_sig);
    const _hashbuf = Hash.sha256(
      Buffer.from(_takeover_url + SEP + _takeover_image)
    );
    const verificationResult = ECDSA.verify(
      _hashbuf,
      sigObj,
      new b.PublicKey(pubKey),
      'little'
    );
    return verificationResult;
  }

  public showInappNotification(data) {
    if (!data.body || data.notification_type === 'NewOutgoingTx') return;

    this.notifications.unshift(data);
    this.runNotificationsQueue();
  }

  private runNotificationsQueue() {
    if (this.currentNotif) return;

    this.notifications.some(data => {
      if (!data.showDone) {
        this.currentNotif = this.modalCtrl.create(
          NotificationComponent,
          {
            title: data.title,
            message: data.body,
            customButton: {
              closeButtonText: data.closeButtonText
                ? data.closeButtonText
                : this.translate.instant('Open Wallet'),
              data: {
                action: data.action ? data.action : 'openWallet'
              }
            }
          },
          {
            showBackdrop: true,
            enableBackdropDismiss: true,
            enterAnimation: 'modal-translate-up-enter',
            leaveAnimation: 'modal-translate-up-leave',
            cssClass: 'in-app-notification-modal'
          }
        );

        this.currentNotif.onDidDismiss(dismissData => {
          if (
            dismissData &&
            dismissData.action &&
            dismissData.action === 'openWallet'
          )
            this._openWallet(data);
          else if (
            dismissData &&
            dismissData.action &&
            dismissData.action === 'goToWalletconnect'
          ) {
            const nextView = {
              name: 'WalletConnectRequestDetailsPage',
              params: {
                force: true,
                request: data.request,
                params: data.request.params
              }
            };
            this.events.publish('IncomingDataRedir', nextView);
          }

          this.currentNotif = null;
          this.runNotificationsQueue();
        });

        this.currentNotif.present().then(() => {
          if (data.autoDismiss) {
            setTimeout(() => {
              this.currentNotif && this.currentNotif.dismiss();
            }, 2000);
          }
        });
        data.showDone = true;
        return true;
      }

      return false;
    });
  }
}
