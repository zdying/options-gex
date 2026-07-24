date="2026-07-23"

ssh arm2 "date='$date' bash -s" << 'EOF'
  cd /home/ubuntu/options-indicator/data/live_data/
  rm $date.zip
  echo "zip $date.zip -r ./$date/"
  zip $date.zip -r ./$date/
  ls -al ./
EOF

scp arm2:/home/ubuntu/options-indicator/data/live_data/${date}.zip ./data/back_data/
cd ./data/back_data/
unzip ${date}.zip
mkdir -p ../live_data/${date}/
cp -r ${date}/* ../live_data/${date}/
